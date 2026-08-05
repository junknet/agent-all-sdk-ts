/**
 * OpenAI Chat Completions provider (including Gemini OpenAI-Compat mode)
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
  WireProvider,
  WirePreparedRequest,
  ModelInfo,
  ClientProtocol,
  QuotaInfo,
} from '../types.js'
import { toCodexEffort } from '../thinking.js'
import type { AnthropicEventEmitter } from '../emitter.js'
import { iterSSE, tryParseJSON } from '../sse.js'
import { splitCachedFromTotalInput } from '../usage.js'

// OpenAI 兼容后端的 prompt_tokens **含**缓存命中部分，缓存命中数各家字段名不同：
// DeepSeek 叫 prompt_cache_hit_tokens(实测 api.deepseek.com)，OpenAI 官方与多数
// 兼容实现叫 prompt_tokens_details.cached_tokens。IR 用 Anthropic 语义(input 不含缓存),
// 所以要先拆出来；两个都没有就当作没有缓存信息，不硬造 0。
function normalizeOpenAIUsage(usage: any): {
  input?: number
  output?: number
  cacheRead?: number
} {
  const cached =
    typeof usage?.prompt_cache_hit_tokens === 'number'
      ? usage.prompt_cache_hit_tokens
      : typeof usage?.prompt_tokens_details?.cached_tokens === 'number'
        ? usage.prompt_tokens_details.cached_tokens
        : undefined
  const split = splitCachedFromTotalInput(usage?.prompt_tokens, cached)
  return { input: split.input, output: usage?.completion_tokens, cacheRead: split.cacheRead }
}

export interface OpenaiCompatOpts {
  baseURL: string
  apiKey: string
  model: string
  /** Authentication form required by the compatible endpoint. */
  authScheme?: 'bearer' | 'x-api-key'
  /**
   * Whether the target model can actually see image_url content. Default true
   * (unchanged historical behaviour). Set false for text-only backends — some
   * OpenAI-compat gateways (e.g. Alibaba DashScope compatible-mode serving a
   * non-vision model like deepseek-v4-flash) accept `image_url` blocks in the
   * wire schema without erroring, but the model silently can't see them: the
   * request 200s and the model just replies "I don't see an image". Blindly
   * embedding megabytes of base64 for a model that can't use it is pure
   * wasted context/tokens and a confusing dead end, so when false we degrade
   * every image block to a short text placeholder instead of image_url.
   * When false (default), OPENAI_MODEL / OPENAI_COMPAT_MODEL may override opts.model.
   * Set true for a routed model whose prefix is the source of truth.
   */
  ignoreEnvironmentModel?: boolean
  supportsImages?: boolean
}

function parseClientProtocol(value: unknown): ClientProtocol | undefined {
  if (
    value === 'anthropic_messages' ||
    value === 'openai_chat_completions' ||
    value === 'openai_responses'
  ) {
    return value
  }
  return undefined
}

export function createOpenaiCompatProvider(opts: OpenaiCompatOpts): WireProvider {
  const targetModel = opts.ignoreEnvironmentModel
    ? opts.model || 'gpt-4o'
    : process.env.OPENAI_MODEL || process.env.OPENAI_COMPAT_MODEL || opts.model || 'gpt-4o'
  const supportsImages = opts.supportsImages ?? true
  const authHeaders: Record<string, string> =
    opts.authScheme === 'x-api-key'
      ? { 'x-api-key': opts.apiKey }
      : { Authorization: `Bearer ${opts.apiKey}` }

  return {
    name: 'openai-compat',

    async buildRequest(req: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const systemText = systemPromptToString(req.system)
      const messages = translateMessages(req.messages, systemText, supportsImages)

      const body: Record<string, unknown> = {
        model: targetModel,
        messages,
        stream: req.stream ?? true,
      }
      if (req.tools && req.tools.length > 0) body.tools = translateTools(req.tools)
      if (req.max_tokens) body.max_tokens = req.max_tokens
      const effort = toCodexEffort(req.reasoning)
      if (effort) body.reasoning_effort = effort
      if (req.serviceTier?.tier === 'priority') body.service_tier = 'priority'

      // o1 / o3 / o4 reasoning models don't accept temperature values other than 1.0, so omit
      if (!/^o[1-9]/.test(targetModel)) {
        body.temperature = typeof req.temperature === 'number' ? req.temperature : 1.0
      }

      if (req.tool_choice) {
        if (req.tool_choice.type === 'any') body.tool_choice = 'required'
        else if (req.tool_choice.type === 'auto') body.tool_choice = 'auto'
        else if (req.tool_choice.type === 'none') body.tool_choice = 'none'
      }

      const bodyStr = JSON.stringify(body)
      return {
        url: `${opts.baseURL.replace(/\/$/, '')}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: bodyStr,
      }
    },

    async parseStream(response: Response, emitter: AnthropicEventEmitter): Promise<void> {
      emitter.start({ model: targetModel })

      const contentType = response.headers.get('content-type') ?? ''
      // Non-streaming response
      if (!contentType.includes('event-stream')) {
        const json = (await response.json().catch(() => null)) as
          | { choices?: Array<{ message?: any; finish_reason?: string }>; usage?: any }
          | null
        if (!json) {
          // 响应体不是 JSON(网关 HTML 错误页、被截断的 body…)。此前直接 finish()，
          // 客户端收到的是一个语法完整但零内容的 200。
          emitter.error({
            type: 'api_error',
            message:
              '[gateway] openai-compat upstream returned a non-streaming body that is not ' +
              'valid JSON; the turn produced no content',
          })
          emitter.finish()
          return
        }
        const choice = json.choices?.[0]
        const msg = choice?.message
        if (!choice) {
          // 非流式响应的终止信号就是 choices 本身；没有它就没有回合可言。
          emitter.error({
            type: 'api_error',
            message:
              '[gateway] openai-compat upstream returned a non-streaming body with no choices; ' +
              'the turn produced no content',
          })
        }
        if (msg) {
          if (typeof msg.content === 'string' && msg.content.length > 0) emitter.pushText(msg.content)
          if (Array.isArray(msg.tool_calls)) {
            let hadTools = false
            for (const tc of msg.tool_calls) {
              const id = tc?.id ?? ''
              const name = tc?.function?.name ?? ''
              const args = tc?.function?.arguments ?? ''
              if (!id || !name) continue
              emitter.openToolUse(id, name)
              if (args) emitter.pushToolArgsDelta(args)
              emitter.closeBlock()
              hadTools = true
            }
            if (hadTools) emitter.setStopReason('tool_use')
          }
        }
        if (json.usage) emitter.setUsage(normalizeOpenAIUsage(json.usage))
        if (choice?.finish_reason === 'length') emitter.setStopReason('max_tokens')
        emitter.finish()
        return
      }

      // Streaming response
      let hadTools = false
      // Chat Completions 流的终止信号是某个 choice 上的 finish_reason；见不到就是被掐断。
      let sawTerminal = false
      const toolByIdx = new Map<number, { id: string; name: string; arguments: string }>()

      const emitBufferedToolCalls = (): void => {
        if (toolByIdx.size === 0) return
        const sorted = [...toolByIdx.entries()].sort(([left], [right]) => left - right)
        for (const [, tool] of sorted) {
          if (!tool.id || !tool.name) continue
          emitter.openToolUse(tool.id, tool.name)
          if (tool.arguments.length > 0) emitter.pushToolArgsDelta(tool.arguments)
          emitter.closeBlock()
        }
        toolByIdx.clear()
      }

      for await (const evt of iterSSE(response)) {
        const chunk = tryParseJSON<any>(evt.data)
        if (!chunk) {
          emitter.unhandled(evt.event ?? '<unparseable>', evt.data)
          continue
        }
        const choice = chunk.choices?.[0]
        const delta = choice?.delta

        // 终止判定单独一行、在所有分支之前：只记账，不参与控制流，出站字节流因此逐字节不变。
        if (choice?.finish_reason) sawTerminal = true

        if (!delta && chunk.usage) {
          emitter.setUsage(normalizeOpenAIUsage(chunk.usage))
          continue
        }
        if (!delta) {
          // 既无 delta、无 usage、也无 finish_reason 的块没有任何人认领 —— 上游换形状了。
          if (!choice?.finish_reason) emitter.unhandled('<no-delta>', chunk)
          continue
        }

        // 1. reasoning_content / reasoning → thinking
        const reasoningDelta = (delta.reasoning_content ?? delta.reasoning) as string | undefined
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          emitter.pushThinking(reasoningDelta)
          emitter.addOutputTokens(1)
        }

        // 2. content → text
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          emitter.pushText(delta.content)
          emitter.addOutputTokens(1)
        }

        // 3. tool_calls
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0
            const fn = tc.function ?? {}
            const current = toolByIdx.get(idx) ?? {
              id: `call_${idx}_${Date.now().toString(36)}`,
              name: '',
              arguments: '',
            }
            if (tc.id) current.id = tc.id
            if (fn.name) current.name = fn.name
            if (typeof fn.arguments === 'string' && fn.arguments.length > 0) {
              current.arguments += fn.arguments
            }
            toolByIdx.set(idx, current)
            hadTools = true
          }
        }

        if (choice?.finish_reason) {
          if (choice.finish_reason === 'tool_calls' || hadTools) {
            emitBufferedToolCalls()
            emitter.setStopReason('tool_use')
          } else if (choice.finish_reason === 'length') {
            emitter.setStopReason('max_tokens')
          } else {
            emitter.setStopReason('end_turn')
          }
          emitter.closeBlock()
        }
      }

      if (hadTools) {
        emitBufferedToolCalls()
        emitter.setStopReason('tool_use')
      }
      // 一个 finish_reason 都没见过 = 上游把流掐了。此前照样 finish()，
      // 客户端拿到的是 stop_reason:'end_turn' 的"正常"收尾。
      if (!sawTerminal) {
        emitter.error({
          type: 'api_error',
          message:
            '[gateway] openai-compat upstream stream ended without a finish_reason; ' +
            'the turn is truncated',
        })
      }
      emitter.finish()
    },

    async listModels(): Promise<ModelInfo[]> {
      const res = await fetch(`${opts.baseURL.replace(/\/$/, '')}/models`, {
        method: 'GET',
        headers: {
          ...authHeaders,
        },
      })
      if (!res.ok) {
        throw new Error(`openai-compat listModels failed: ${res.status}`)
      }
      const data = (await res.json()) as any
      const list = data.data || []
      return list.map((m: any) => ({
        id: m.id,
        name: m.display_name || m.id,
        ...(parseClientProtocol(m.client_protocol)
          ? { clientProtocol: parseClientProtocol(m.client_protocol) }
          : {}),
      }))
    },

    async getQuota(): Promise<QuotaInfo> {
      return {
        planType: 'openai-compat-plan',
      }
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function systemPromptToString(system: AnthropicMessagesRequest['system']): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map(b => (b.type === 'text' ? b.text ?? '' : ''))
    .filter(Boolean)
    .join('\n')
}

function translateTools(tools: AnthropicTool[]): Array<Record<string, unknown>> {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }))
}

// Placeholder dropped in place of an image block when the target model has no vision
// capability, so the turn still reads coherently instead of silently vanishing. Leading
// newline keeps it visually separated when concatenated after preceding text (textParts
// are joined with '' to match this file's existing multi-text-block behaviour).
const IMAGE_UNSUPPORTED_PLACEHOLDER = '\n[image omitted: this model does not support image input]'

function translateMessages(
  messages: AnthropicMessage[],
  systemPrompt: string,
  supportsImages: boolean,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt })

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      if (msg.content.length > 0) {
        out.push({ role: msg.role, content: msg.content })
      }
      continue
    }
    if (!Array.isArray(msg.content)) continue

    const textParts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []
    const contentParts: Array<Record<string, unknown>> = []
    let hasImage = false

    for (const block of msg.content as AnthropicContentBlock[]) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        textParts.push(block.text)
      } else if (block.type === 'image' && block.source && block.source.type === 'base64') {
        if (!supportsImages) {
          textParts.push(IMAGE_UNSUPPORTED_PLACEHOLDER)
          continue
        }
        hasImage = true
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        })
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        })
      } else if (block.type === 'tool_result') {
        let toolContent: string
        if (typeof block.content === 'string') {
          toolContent = block.content
        } else if (Array.isArray(block.content)) {
          const parts = (block.content as AnthropicContentBlock[])
            .filter(b => b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text as string)
          let joinedText = parts.join('')

          const imageParts = supportsImages
            ? (block.content as AnthropicContentBlock[])
                .filter(b => b.type === 'image' && b.source && b.source.type === 'base64')
                .map(b => {
                  const src = b.source as any
                  return `\n![image](data:${src.media_type};base64,${src.data})`
                })
            : (block.content as AnthropicContentBlock[])
                .filter(b => b.type === 'image' && b.source && b.source.type === 'base64')
                .map(() => IMAGE_UNSUPPORTED_PLACEHOLDER)
          toolContent = joinedText + imageParts.join('')
          if (toolContent.length === 0) {
            toolContent = JSON.stringify(block.content)
          }
        } else {
          toolContent = JSON.stringify(block.content ?? '')
        }
        if (toolContent.length === 0) toolContent = '(empty)'
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: toolContent,
        })
      }
    }

    const joinedText = textParts.join('')
    if (hasImage && joinedText.length > 0) {
      contentParts.unshift({ type: 'text', text: joinedText })
    }

    if (toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: hasImage ? contentParts : (joinedText.length > 0 ? joinedText : ' '),
        tool_calls: toolCalls,
      })
    } else if (hasImage) {
      out.push({ role: msg.role, content: contentParts })
    } else if (joinedText.length > 0) {
      out.push({ role: msg.role, content: joinedText })
    }
  }

  return out.filter(m => {
    if (m.role === 'tool') return true
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0) {
      return true
    }
    const c = m.content
    if (c === null || c === undefined) return false
    if (typeof c === 'string') return c.length > 0
    if (Array.isArray(c)) return c.length > 0
    return true
  })
}
