import type { IngressAdapter, AnthropicMessagesRequest } from './types.js'
import { iterSSE } from './sse.js'
import { decodeResponsesToAnthropic, encodeAnthropicToResponsesSSE } from './responses_api.js'

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
      out.push({ type: 'text', text: p.text })
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

// OpenAI 用 reasoning_effort 字符串档位，Anthropic 用 thinking.budget_tokens 数值。
// 请求侧原先完全不接推理字段(只在响应侧回 reasoning_content)，于是任何经
// /v1/chat/completions 的客户端都无法控制思考档位 —— 下游 harness 的"调推理等级"是死的。
// 档位→预算的映射与 codex_provider 的反向映射保持一致(low≤1024 / medium≤4096 / high)。
const EFFORT_BUDGET: Record<string, number> = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 4096,
  high: 10000,
  xhigh: 20000,
  max: 32000,
}

function effortToThinking(raw: unknown): { type: 'enabled'; budget_tokens: number } | undefined {
  const key =
    typeof raw === 'string' ? raw : typeof (raw as any)?.effort === 'string' ? (raw as any).effort : ''
  const v = EFFORT_BUDGET[key.toLowerCase()]
  if (v === undefined || v <= 0) return undefined
  return { type: 'enabled', budget_tokens: v }
}

// ── Messages Ingress Adapter (Anthropic /v1/messages) ────────────────
export class MessagesIngressAdapter implements IngressAdapter {
  readonly protocol = 'messages'

  decodeRequest(rawBody: any): AnthropicMessagesRequest {
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

    const req: any = {
      model: rawBody.model,
      messages,
      stream: rawBody.stream ?? false,
    }

    if (systemPrompt) req.system = systemPrompt
    // max_tokens 在 OpenAI Chat 协议里可省略，在 Anthropic Messages 里是必填 ——
    // 省略时上游直接 400 "max_tokens: Field required"，整轮请求死(实测 jcode 的
    // openai-compatible provider 就不发这个字段)。这里给 IR 补一个默认上限；
    // 客户端显式给了就用客户端的。可用 AGENT_GATEWAY_DEFAULT_MAX_TOKENS 调整。
    const envDefault = Number(process.env.AGENT_GATEWAY_DEFAULT_MAX_TOKENS)
    req.max_tokens =
      rawBody.max_tokens ??
      rawBody.max_completion_tokens ??
      (Number.isFinite(envDefault) && envDefault > 0 ? envDefault : 65536)
    // reasoning_effort 是 OpenAI 的顶层字段；reasoning:{effort} 是 Responses 风格。
    // 客户端没给时用 AGENT_GATEWAY_DEFAULT_EFFORT(默认不开思考，保持原行为)。
    const think =
      effortToThinking(rawBody.reasoning_effort) ??
      effortToThinking(rawBody.reasoning) ??
      effortToThinking(process.env.AGENT_GATEWAY_DEFAULT_EFFORT)
    if (think) req.thinking = think
    if (typeof rawBody.temperature === 'number') req.temperature = rawBody.temperature
    if (typeof rawBody.top_p === 'number') req.top_p = rawBody.top_p

    if (Array.isArray(rawBody.tools)) {
      req.tools = rawBody.tools.map((t: any) => ({
        name: t.function?.name,
        description: t.function?.description,
        input_schema: t.function?.parameters,
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

      for await (const ev of streamEvents) {
        try {
          const payload = JSON.parse(ev.data)
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
      }

      return new Response(JSON.stringify(responseBody), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Handle Stream Response: Transform Anthropic SSE stream to OpenAI SSE stream
    const encoder = new TextEncoder()
    const transformStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of iterSSE(upstreamResponse)) {
            const openaiChunk = translateAnthropicToOpenAISSE(event, model)
            if (openaiChunk) {
              controller.enqueue(encoder.encode(openaiChunk))
            }
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
      return 'data: [DONE]\n\n'
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
