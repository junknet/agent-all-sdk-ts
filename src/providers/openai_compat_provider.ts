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
  QuotaInfo,
} from '../types.js'
import type { AnthropicEventEmitter } from '../emitter.js'
import { iterSSE, tryParseJSON } from '../sse.js'

export interface OpenaiCompatOpts {
  baseURL: string
  apiKey: string
  model: string
}

export function createOpenaiCompatProvider(opts: OpenaiCompatOpts): WireProvider {
  const targetModel =
    process.env.OPENAI_MODEL || process.env.OPENAI_COMPAT_MODEL || opts.model || 'gpt-4o'

  return {
    name: 'openai-compat',

    async buildRequest(req: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const systemText = systemPromptToString(req.system)
      const messages = translateMessages(req.messages, systemText)

      const body: Record<string, unknown> = {
        model: targetModel,
        messages,
        stream: req.stream ?? true,
      }
      if (req.tools && req.tools.length > 0) body.tools = translateTools(req.tools)
      if (req.max_tokens) body.max_tokens = req.max_tokens

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
      if (process.env.BENCH_LOG_DIR) {
        try {
          const fs = await import('fs/promises')
          const path = await import('path')
          const dir = process.env.BENCH_LOG_DIR
          await fs.mkdir(dir, { recursive: true })
          await fs.appendFile(
            path.join(dir, 'wire-requests.ndjson'),
            JSON.stringify({ ts: new Date().toISOString(), provider: 'openai-compat', body: JSON.parse(bodyStr) }) + '\n',
          )
        } catch {}
      }
      return {
        url: `${opts.baseURL.replace(/\/$/, '')}/chat/completions`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
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
          emitter.finish()
          return
        }
        const choice = json.choices?.[0]
        const msg = choice?.message
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
        if (json.usage) {
          emitter.setUsage({
            input: json.usage.prompt_tokens,
            output: json.usage.completion_tokens,
          })
        }
        if (choice?.finish_reason === 'length') emitter.setStopReason('max_tokens')
        emitter.finish()
        return
      }

      // Streaming response
      let hadTools = false
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
        if (!chunk) continue
        const choice = chunk.choices?.[0]
        const delta = choice?.delta

        if (!delta && chunk.usage) {
          emitter.setUsage({
            input: chunk.usage.prompt_tokens,
            output: chunk.usage.completion_tokens,
          })
          continue
        }
        if (!delta) continue

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
      emitter.finish()
    },

    async listModels(): Promise<ModelInfo[]> {
      const res = await fetch(`${opts.baseURL.replace(/\/$/, '')}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${opts.apiKey}`,
        },
      })
      if (!res.ok) {
        throw new Error(`openai-compat listModels failed: ${res.status}`)
      }
      const data = (await res.json()) as any
      const list = data.data || []
      return list.map((m: any) => ({
        id: m.id,
        name: m.id,
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

function translateMessages(
  messages: AnthropicMessage[],
  systemPrompt: string,
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

          const imageParts = (block.content as AnthropicContentBlock[])
            .filter(b => b.type === 'image' && b.source && b.source.type === 'base64')
            .map(b => {
              const src = b.source as any
              return `\n![image](data:${src.media_type};base64,${src.data})`
            })
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
