import type { IngressAdapter, AnthropicMessagesRequest } from './types.js'
import { iterSSE, tryParseJSON } from './sse.js'
import { decodeResponsesToAnthropic, encodeAnthropicToResponsesSSE } from './responses_api.js'
import { parseAnthropicThinking, parseReasoningEffort } from './thinking.js'
import { normalizeToolTurns, resolveDefaultMaxTokens } from './anthropic_constraints.js'
import { createUsageCollector, toOpenAIChatUsage } from './usage.js'

// OpenAI 的 tool_calls.function.arguments 是 JSON 字符串，Anthropic 的
// tool_use.input 是对象。解析失败时兜成空对象，避免整轮请求因一个坏参数挂掉。
function safeParseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

// OpenAI Chat 的多模态 content 是 [{type:'text'|'image_url', …}]，Anthropic 侧是
// [{type:'text'|'image', …}]。原实现对数组型 content 原样透传，于是客户端一粘图就
// 400: "messages.N.content.0: Input tag 'image_url' … does not match any of the
// expected tags"（实测 jcode 粘截图必现）。这里做块级转换。
function convertChatContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content ?? ''
  const out: unknown[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as any
    if (p.type === 'text' && typeof p.text === 'string') {
      // 空 text 块必须丢掉，不能原样转过去：上游 400 "messages: text content blocks
      // must be non-empty"。OpenAI 客户端粘图时非常容易发出
      // [{type:'text',text:''},{type:'image_url',…}] 这种"没配文字的图"形状，
      // 实测经 /v1/chat/completions 打 claude-fable-5 必死。
      if (p.text !== '') out.push({ type: 'text', text: p.text })
      continue
    }
    if (p.type === 'image_url') {
      const url: string = typeof p.image_url === 'string' ? p.image_url : (p.image_url?.url ?? '')
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url)
      if (m) {
        out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
      } else if (url) {
        // 远端 URL：Anthropic 支持 source.type='url'
        out.push({ type: 'image', source: { type: 'url', url } })
      }
      continue
    }
    // 已经是 Anthropic 形状(text/image/tool_use/tool_result/thinking…)就原样保留
    if (typeof p.type === 'string') out.push(p)
  }
  return out.length > 0 ? out : ''
}

// 工具回合的归一(每个 tool_use 恰好一个 tool_result、紧随其后、排在最前、孤儿丢弃)
// 统一由 anthropic_constraints.normalizeToolTurns 负责，三个入口共用一套 —— 这类缺陷
// 的历史教训就是"一个入口修一次"永远漏，见该文件顶部的实测约束表。

// OpenAI 用 reasoning_effort 字符串档位，Anthropic 用 thinking.budget_tokens 数值。
// 请求侧原先完全不接推理字段(只在响应侧回 reasoning_content)，于是任何经
// /v1/chat/completions 的客户端都无法控制思考档位 —— 下游 harness 的"调推理等级"是死的。
// 档位→预算由 thinking.ts 统一管理；显式 none/off 必须压过网关默认档位。
// ── Messages Ingress Adapter (Anthropic /v1/messages) ────────────────
export class MessagesIngressAdapter implements IngressAdapter {
  readonly protocol = 'messages'

  decodeRequest(rawBody: any): AnthropicMessagesRequest {
    if (Array.isArray(rawBody?.messages)) {
      normalizeToolTurns(rawBody.messages)
    }
    const explicitEffort =
      rawBody.openai_reasoning_effort ?? rawBody.reasoning_effort ?? rawBody.reasoning
    const clientReasoning = parseAnthropicThinking(rawBody.thinking) ?? parseReasoningEffort(explicitEffort)
    rawBody.reasoning =
      clientReasoning ?? parseReasoningEffort(process.env.AGENT_GATEWAY_DEFAULT_EFFORT, 'gateway-default')
    // 这三个键是 OpenAI 的档位表达，Anthropic 的 /v1/messages 不认，而本 adapter 是
    // 近乎透传的 —— 读完不删就会原样带到上游，400 "reasoning_effort: Extra inputs are
    // not permitted"(实测 2026-08-03，claude-fable-5)。等于网关一边宣称支持这个入参，
    // 一边保证用了它就挂。消费掉就必须删掉。
    for (const key of ['openai_reasoning_effort', 'reasoning_effort', 'thinking']) {
      if (key in rawBody) delete rawBody[key]
    }
    return rawBody as AnthropicMessagesRequest
  }

  encodeResponse(upstreamResponse: Response): Response {
    // Transparent passthrough since upstream already outputs Anthropic SSE
    return upstreamResponse
  }
}

// ── Chat Ingress Adapter (OpenAI /v1/chat/completions) ───────────────
export class ChatIngressAdapter implements IngressAdapter {
  readonly protocol = 'chat'

  decodeRequest(rawBody: any): AnthropicMessagesRequest {
    const messages: any[] = []
    let systemPrompt = ''

    if (Array.isArray(rawBody.messages)) {
      for (const msg of rawBody.messages) {
        if (msg.role === 'system') {
          systemPrompt = (systemPrompt ? systemPrompt + '\n' : '') + msg.content
        } else if (msg.role === 'tool') {
          // OpenAI 的工具结果是一条独立的 role:"tool" 消息；Anthropic 侧它是 user
          // 消息里的 tool_result 块，且 tool_use_id 必须与之前的 tool_use.id 对上。
          messages.push({
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: msg.tool_call_id,
                content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? ''),
              },
            ],
          })
        } else if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          // 带 tool_calls 的 assistant 消息在 OpenAI 侧 content 允许为 null。原来
          // 直接透传 content:null，上游 400 "messages.N.content: Field required"，
          // 于是任何走 /v1/chat/completions 的多轮工具循环第二轮就死(实测 jcode)。
          const blocks: any[] = []
          if (typeof msg.content === 'string' && msg.content) {
            blocks.push({ type: 'text', text: msg.content })
          }
          for (const tc of msg.tool_calls) {
            blocks.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function?.name,
              input: safeParseArgs(tc.function?.arguments),
            })
          }
          messages.push({ role: 'assistant', content: blocks })
        } else {
          // content 可能是 null/undefined(极少数客户端会发空 assistant 回合)，
          // 归一成空串而不是原样透传，同样是为了避开上游必填校验。
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: convertChatContent(msg.content),
          })
        }
      }
    }

    normalizeToolTurns(messages)

    const req: any = {
      model: rawBody.model,
      messages,
      stream: rawBody.stream ?? false,
    }

    if (systemPrompt) req.system = systemPrompt
    // max_tokens 在 OpenAI Chat 协议里可省略，在 Anthropic Messages 里是必填 ——
    // 省略时上游直接 400 "max_tokens: Field required"，整轮请求死(实测 jcode 的
    // openai-compatible provider 就不发这个字段)。这里给 IR 补一个默认上限；
    // 客户端显式给了就用客户端的。兜底值与 /v1/responses 入口共用。
    req.max_tokens =
      rawBody.max_tokens ?? rawBody.max_completion_tokens ?? resolveDefaultMaxTokens()
    // reasoning_effort 是 OpenAI 的顶层字段；reasoning:{effort} 是 Responses 风格。
    // 客户端没给时用 AGENT_GATEWAY_DEFAULT_EFFORT(默认不开思考，保持原行为)。
    const explicitEffort = rawBody.reasoning_effort ?? rawBody.reasoning
    const reasoning = parseReasoningEffort(explicitEffort) ??
      parseReasoningEffort(process.env.AGENT_GATEWAY_DEFAULT_EFFORT, 'gateway-default')
    if (reasoning) req.reasoning = reasoning
    if (typeof rawBody.temperature === 'number') req.temperature = rawBody.temperature
    if (typeof rawBody.top_p === 'number') req.top_p = rawBody.top_p

    if (Array.isArray(rawBody.tools)) {
      // OpenAI 的 function.parameters 对无参工具可以整个省略，Anthropic 的
      // input_schema 是必填且必须是对象 —— 缺了上游 400
      // "tools.0.custom.input_schema: Field required"，非对象则 400
      // "input_schema: Input does not match the expected shape."(两条都实测过)。
      // 补一个空对象 schema 即可，语义等价于"这个工具不收参数"。
      // /v1/responses 入口早就这么兜底了，这里是把两个 OpenAI 入口拉齐。
      req.tools = rawBody.tools.map((t: any) => ({
        name: t.function?.name,
        description: t.function?.description,
        input_schema:
          t.function?.parameters && typeof t.function.parameters === 'object'
            ? t.function.parameters
            : { type: 'object', properties: {} },
      }))
    }

    return req
  }

  async encodeResponse(
    upstreamResponse: Response,
    originalRequest: any,
    trace: string,
  ): Promise<Response> {
    const model = originalRequest.model ?? 'openai-compat'

    // Handle Non-Stream Response
    if (!originalRequest.stream) {
      const streamEvents = await iterSSE(upstreamResponse)
      let content = ''
      let reasoning = ''
      const toolCalls: any[] = []
      const usage = createUsageCollector()

      for await (const ev of streamEvents) {
        try {
          const payload = JSON.parse(ev.data)
          usage.observe(payload)
          if (payload.type === 'content_block_delta') {
            if (payload.delta?.type === 'text_delta') content += payload.delta.text
            if (payload.delta?.type === 'thinking_delta') reasoning += payload.delta.thinking
            if (payload.delta?.type === 'input_json_delta') {
              const tc = toolCalls[payload.index ?? 0]
              if (tc) tc.function.arguments += payload.delta.partial_json
            }
          }
          if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
            const tc = payload.content_block
            toolCalls[payload.index ?? 0] = {
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: '' },
            }
          }
        } catch {}
      }

      const responseBody: Record<string, any> = {
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: content || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls.filter(Boolean) } : {}),
          },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        }],
        // 非流式的 usage 在 OpenAI 契约里是**无条件**回的(不受 stream_options 约束)。
        // 缺了它下游 harness 算不出上下文占用，70% 压缩阈值就是死的。
        usage: toOpenAIChatUsage(usage.snapshot()),
      }

      return new Response(JSON.stringify(responseBody), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Handle Stream Response: Transform Anthropic SSE stream to OpenAI SSE stream
    const encoder = new TextEncoder()
    // OpenAI 契约: 流式的 usage 只在客户端显式 stream_options.include_usage=true 时回，
    // 形式是 [DONE] 之前多发一个 choices:[] 且带 usage 的 chunk。无条件塞会让按契约
    // 严格解析的客户端在 choices[0] 上炸掉，所以这里必须看客户端有没有声明。
    const includeUsage = originalRequest?.stream_options?.include_usage === true
    const usage = createUsageCollector()
    const transformStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of iterSSE(upstreamResponse)) {
            const payload = tryParseJSON<any>(event.data)
            if (payload) usage.observe(payload)
            const openaiChunk = translateAnthropicToOpenAISSE(event, model)
            if (!openaiChunk) continue
            if (includeUsage && openaiChunk === DONE_SENTINEL) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    id: `chatcmpl-${Date.now().toString(36)}`,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [],
                    usage: toOpenAIChatUsage(usage.snapshot()),
                  })}\n\n`,
                ),
              )
            }
            controller.enqueue(encoder.encode(openaiChunk))
          }
        } catch (err: any) {
          console.error('SSE transformation failed:', err)
        } finally {
          controller.close()
        }
      },
    })

    return new Response(transformStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}

// 流结束哨兵。单独抽出来是因为调用方要在它之前插 usage chunk，靠字符串相等来认。
const DONE_SENTINEL = 'data: [DONE]\n\n'

// Helper: translate Anthropic event to OpenAI completions delta
function translateAnthropicToOpenAISSE(event: { event?: string; data: string }, model: string): string | null {
  try {
    const payload = JSON.parse(event.data)
    const id = `chatcmpl-${Date.now().toString(36)}`

    const baseChunk = (delta: any, finishReason: string | null = null) => {
      return JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta,
          finish_reason: finishReason,
        }],
      })
    }

    if (payload.type === 'content_block_delta') {
      const delta = payload.delta
      if (delta.type === 'text_delta') {
        return `data: ${baseChunk({ content: delta.text })}\n\n`
      }
      if (delta.type === 'thinking_delta') {
        return `data: ${baseChunk({ reasoning_content: delta.thinking })}\n\n`
      }
      if (delta.type === 'input_json_delta') {
        return `data: ${baseChunk({
          tool_calls: [{
            index: payload.index ?? 0,
            function: { arguments: delta.partial_json },
          }],
        })}\n\n`
      }
    }

    if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
      const tool = payload.content_block
      return `data: ${baseChunk({
        tool_calls: [{
          index: payload.index ?? 0,
          id: tool.id,
          type: 'function',
          function: { name: tool.name, arguments: '' },
        }],
      })}\n\n`
    }

    if (payload.type === 'message_delta') {
      const stopReason = payload.delta?.stop_reason
      const mappedReason = stopReason === 'end_turn' ? 'stop' : stopReason === 'tool_use' ? 'tool_calls' : stopReason
      return `data: ${baseChunk({}, mappedReason)}\n\n`
    }

    if (payload.type === 'message_stop') {
      return DONE_SENTINEL
    }
  } catch {}
  return null
}

// ── Responses Ingress Adapter (OpenAI Responses /v1/responses) ───────
export class ResponsesIngressAdapter implements IngressAdapter {
  readonly protocol = 'responses'

  decodeRequest(rawBody: any): AnthropicMessagesRequest {
    const { request } = decodeResponsesToAnthropic(rawBody)
    return request
  }

  encodeResponse(
    upstreamResponse: Response,
    originalRequest: any,
    trace: string,
    context?: any,
  ): Response {
    const namespaceTools = context?.namespaceTools
    const stream = encodeAnthropicToResponsesSSE(upstreamResponse, originalRequest.model, trace, namespaceTools)
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}

// ── Global Ingress Dispatcher ───────────────────────────────────────
const ADAPTERS: Record<string, IngressAdapter> = {
  messages: new MessagesIngressAdapter(),
  chat: new ChatIngressAdapter(),
  responses: new ResponsesIngressAdapter(),
}

export function pickIngressAdapter(protocol: 'messages' | 'chat' | 'responses'): IngressAdapter {
  const adapter = ADAPTERS[protocol]
  if (!adapter) throw new Error(`Unsupported ingress protocol: ${protocol}`)
  return adapter
}
