/**
 * OpenAI Responses API inbound (/v1/responses) ⇄ Anthropic-canonical bridge.
 *
 * codex CLI (`wire_api="responses"`) speaks the Responses protocol: requests carry
 * `instructions` + `input[]` (ResponseItem[]) instead of `messages[]`, and it expects
 * the reply as `response.*` SSE events (NOT chat.completion chunks). This module is the
 * exact inverse of provider/codex_provider.ts: that file translates Anthropic→Responses
 * for the OUTBOUND codex backend; here we translate Responses→Anthropic on the INBOUND
 * edge and re-encode the Anthropic-canonical SSE stream back into Responses events.
 *
 * Correctness invariants (the round-trip pieces that break first):
 *  - call_id is preserved verbatim across turns: Responses function_call.call_id ⇄
 *    Anthropic tool_use.id ⇄ tool_result.tool_use_id ⇄ function_call_output.call_id.
 *    A drifted call_id desyncs multi-turn tool conversations.
 *  - Parallel tool calls: each tool_use block becomes its own output item with a
 *    distinct, monotonically increasing output_index.
 *  - arguments are a JSON *string* on the Responses wire but an *object* in Anthropic
 *    tool_use.input; decode parses, encode stringifies.
 *  - Replayed history (function_call / function_call_output / reasoning items codex
 *    sends back after auto-compaction) decodes losslessly.
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
} from './types.js'
import { iterSSE, formatSSE, tryParseJSON } from './sse.js'
import { devlog } from './devlog.js'

// ── id generation ────────────────────────────────────────────────────
let idCounter = 0
function genId(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`
}

// ── reasoning effort → Anthropic thinking budget ─────────────────────
// codex always sends reasoning.effort; map it to a thinking budget so the Gemini
// backend (antigravity) turns on thoughts. effort=none disables thinking entirely.
function effortToThinking(
  reasoning: { effort?: string } | undefined,
): AnthropicMessagesRequest['thinking'] {
  const effort = reasoning?.effort
  if (!effort || effort === 'none') return undefined
  const budget =
    effort === 'minimal' || effort === 'low'
      ? 1024
      : effort === 'medium'
        ? 4096
        : 10000 // high / xhigh
  return { type: 'enabled', budget_tokens: budget }
}

// ── data: URL → Anthropic base64 image source ────────────────────────
function dataUrlToImageBlock(imageUrl: string): AnthropicContentBlock | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(imageUrl)
  if (!m) return null
  return { type: 'image', source: { type: 'base64', media_type: m[1]!, data: m[2]! } }
}

// ── tools: Responses tool defs → Anthropic tool defs ─────────────────
function decodeTools(tools: any[] | undefined): AnthropicTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out: AnthropicTool[] = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    if (t.type === 'function' || t.name) {
      out.push({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.parameters ?? { type: 'object', properties: {} },
      })
    } else if (t.type === 'custom') {
      // freeform custom tool (e.g. apply_patch): expose a single string `input`
      // arg so the Gemini backend, which only knows JSON function calls, can drive it.
      out.push({
        name: t.name,
        description: t.description ?? '',
        input_schema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
        },
      })
    }
    // builtins (local_shell / web_search / image_generation) are dropped: the Gemini
    // backend cannot execute them. codex falls back to function tools for file work.
  }
  return out.length > 0 ? out : undefined
}

// ── content parts of a Responses `message` item → Anthropic blocks ───
function decodeMessageContent(content: unknown): AnthropicContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const blocks: AnthropicContentBlock[] = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as any
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
      if (typeof p.text === 'string' && p.text) blocks.push({ type: 'text', text: p.text })
    } else if (p.type === 'input_image' && typeof p.image_url === 'string') {
      const img = dataUrlToImageBlock(p.image_url)
      if (img) blocks.push(img)
    }
  }
  return blocks
}

/**
 * Decode a Responses API request into the Anthropic-canonical request the wire
 * adapters consume. Groups consecutive same-role items into single messages so the
 * downstream Gemini/Claude backends see clean alternating turns.
 */
export function decodeResponsesToAnthropic(req: any): AnthropicMessagesRequest {
  const systemTexts: string[] = []
  if (typeof req.instructions === 'string' && req.instructions) systemTexts.push(req.instructions)

  const messages: AnthropicMessage[] = []
  let curRole: 'user' | 'assistant' | null = null
  let curBlocks: AnthropicContentBlock[] = []
  const flush = (): void => {
    if (curRole && curBlocks.length > 0) messages.push({ role: curRole, content: curBlocks })
    curRole = null
    curBlocks = []
  }
  const push = (role: 'user' | 'assistant', block: AnthropicContentBlock): void => {
    if (curRole !== role) flush()
    curRole = role
    curBlocks.push(block)
  }

  const input = Array.isArray(req.input) ? req.input : []
  for (const raw of input) {
    if (typeof raw === 'string') {
      push('user', { type: 'text', text: raw })
      continue
    }
    if (!raw || typeof raw !== 'object') continue
    const item = raw as any
    switch (item.type) {
      case undefined:
      case 'message': {
        const role = item.role === 'assistant' ? 'assistant' : 'user'
        if (role === 'user' && (item.role === 'system' || item.role === 'developer')) {
          // developer/system turns are system prompt, not conversation
          for (const b of decodeMessageContent(item.content)) if (b.text) systemTexts.push(b.text)
          break
        }
        for (const b of decodeMessageContent(item.content)) push(role, b)
        break
      }
      case 'function_call':
        push('assistant', {
          type: 'tool_use',
          id: item.call_id ?? item.id ?? genId('call'),
          name: item.name ?? '',
          input: (tryParseJSON<Record<string, unknown>>(item.arguments ?? '{}') ?? {}) as Record<
            string,
            unknown
          >,
        })
        break
      case 'custom_tool_call':
        push('assistant', {
          type: 'tool_use',
          id: item.call_id ?? item.id ?? genId('call'),
          name: item.name ?? '',
          input: { input: typeof item.input === 'string' ? item.input : JSON.stringify(item.input ?? '') },
        })
        break
      case 'function_call_output':
      case 'custom_tool_call_output':
        push('user', {
          type: 'tool_result',
          tool_use_id: item.call_id ?? genId('call'),
          content: outputToString(item.output),
        })
        break
      case 'reasoning':
        // server-managed reasoning history (encrypted_content) — not replayable to the
        // Gemini backend; drop. The next user/tool turn carries the actual context.
        break
      default:
        break
    }
  }
  flush()

  const out: AnthropicMessagesRequest = {
    model: req.model,
    messages,
    stream: true,
  }
  if (systemTexts.length > 0) out.system = systemTexts.join('\n\n')
  const tools = decodeTools(req.tools)
  if (tools) out.tools = tools
  if (req.max_output_tokens) out.max_tokens = req.max_output_tokens
  if (typeof req.temperature === 'number') out.temperature = req.temperature
  if (typeof req.top_p === 'number') out.top_p = req.top_p
  const thinking = effortToThinking(req.reasoning)
  if (thinking) out.thinking = thinking
  const tc = toolChoice(req.tool_choice)
  if (tc) out.tool_choice = tc
  return out
}

function outputToString(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((c: any) => (c?.type === 'text' || c?.type === 'output_text' ? (c.text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (output && typeof output === 'object') return JSON.stringify(output)
  return ''
}

function toolChoice(choice: unknown): AnthropicMessagesRequest['tool_choice'] {
  if (!choice) return undefined
  if (choice === 'auto') return { type: 'auto' }
  if (choice === 'required') return { type: 'any' }
  if (choice === 'none') return { type: 'none' }
  if (typeof choice === 'object' && (choice as any).name) {
    return { type: 'tool', name: (choice as any).name }
  }
  return undefined
}

// ── Encode: Anthropic-canonical SSE → Responses API SSE ──────────────

interface OutItem {
  outputIndex: number
  itemId: string
  kind: 'text' | 'thinking' | 'tool'
  callId?: string
  name?: string
  buf: string
  final: Record<string, unknown> | null
}

/**
 * Consume the Anthropic-canonical SSE stream from a wire adapter and re-emit it as the
 * Responses API event sequence codex-rs parses: response.created → per-item
 * output_item.added / *_delta / output_item.done → response.completed (with usage).
 */
export function encodeAnthropicToResponsesSSE(
  anthropicResponse: Response,
  model: string,
  trace?: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const responseId = genId('resp')
  const created = Math.floor(Date.now() / 1000)

  // anthropic block index → our output item state
  const items = new Map<number, OutItem>()
  const finalItems: Array<Record<string, unknown>> = []
  let outputCounter = 0
  let usageIn = 0
  let usageOut = 0
  let stopReason = 'end_turn'

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown): void => {
        if (trace) devlog(trace, 'outbound_responses', { event, data })
        controller.enqueue(encoder.encode(formatSSE(event, data)))
      }
      const responseEnvelope = (status: string): Record<string, unknown> => ({
        id: responseId,
        object: 'response',
        created_at: created,
        status,
        model,
        output: finalItems,
        usage: {
          input_tokens: usageIn,
          output_tokens: usageOut,
          total_tokens: usageIn + usageOut,
        },
      })

      send('response.created', { type: 'response.created', response: responseEnvelope('in_progress') })
      send('response.in_progress', { type: 'response.in_progress', response: responseEnvelope('in_progress') })

      try {
        for await (const ev of iterSSE(anthropicResponse)) {
          const data = tryParseJSON<any>(ev.data)
          if (!data) continue

          switch (data.type) {
            case 'message_start': {
              const u = data.message?.usage
              if (typeof u?.input_tokens === 'number') usageIn = u.input_tokens
              break
            }
            case 'content_block_start': {
              const idx: number = data.index
              const cb = data.content_block ?? {}
              if (cb.type === 'tool_use') {
                const it: OutItem = {
                  outputIndex: outputCounter++,
                  itemId: genId('fc'),
                  kind: 'tool',
                  callId: cb.id ?? genId('call'),
                  name: cb.name ?? '',
                  buf: '',
                  final: null,
                }
                items.set(idx, it)
                send('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: it.outputIndex,
                  item: {
                    id: it.itemId,
                    type: 'function_call',
                    status: 'in_progress',
                    call_id: it.callId,
                    name: it.name,
                    arguments: '',
                  },
                })
              } else if (cb.type === 'thinking') {
                const it: OutItem = {
                  outputIndex: outputCounter++,
                  itemId: genId('rs'),
                  kind: 'thinking',
                  buf: '',
                  final: null,
                }
                items.set(idx, it)
                send('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: it.outputIndex,
                  item: { id: it.itemId, type: 'reasoning', summary: [] },
                })
              } else {
                // text
                const it: OutItem = {
                  outputIndex: outputCounter++,
                  itemId: genId('msg'),
                  kind: 'text',
                  buf: '',
                  final: null,
                }
                items.set(idx, it)
                send('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: it.outputIndex,
                  item: { id: it.itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
                })
                send('response.content_part.added', {
                  type: 'response.content_part.added',
                  output_index: it.outputIndex,
                  item_id: it.itemId,
                  content_index: 0,
                  part: { type: 'output_text', text: '', annotations: [] },
                })
              }
              break
            }
            case 'content_block_delta': {
              const it = items.get(data.index)
              if (!it) break
              const d = data.delta ?? {}
              if (d.type === 'text_delta' && it.kind === 'text') {
                it.buf += d.text ?? ''
                send('response.output_text.delta', {
                  type: 'response.output_text.delta',
                  output_index: it.outputIndex,
                  item_id: it.itemId,
                  content_index: 0,
                  delta: d.text ?? '',
                })
              } else if (d.type === 'thinking_delta' && it.kind === 'thinking') {
                it.buf += d.thinking ?? ''
                send('response.reasoning_summary_text.delta', {
                  type: 'response.reasoning_summary_text.delta',
                  output_index: it.outputIndex,
                  item_id: it.itemId,
                  summary_index: 0,
                  delta: d.thinking ?? '',
                })
              } else if (d.type === 'input_json_delta' && it.kind === 'tool') {
                it.buf += d.partial_json ?? ''
                send('response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  output_index: it.outputIndex,
                  item_id: it.itemId,
                  call_id: it.callId,
                  delta: d.partial_json ?? '',
                })
              }
              break
            }
            case 'content_block_stop': {
              const it = items.get(data.index)
              if (!it) break
              if (it.kind === 'text') {
                send('response.output_text.done', {
                  type: 'response.output_text.done',
                  output_index: it.outputIndex,
                  item_id: it.itemId,
                  content_index: 0,
                  text: it.buf,
                })
                const part = { type: 'output_text', text: it.buf, annotations: [] }
                send('response.content_part.done', {
                  type: 'response.content_part.done',
                  output_index: it.outputIndex,
                  item_id: it.itemId,
                  content_index: 0,
                  part,
                })
                it.final = {
                  id: it.itemId,
                  type: 'message',
                  status: 'completed',
                  role: 'assistant',
                  content: [part],
                }
              } else if (it.kind === 'thinking') {
                it.final = {
                  id: it.itemId,
                  type: 'reasoning',
                  summary: it.buf ? [{ type: 'summary_text', text: it.buf }] : [],
                }
              } else {
                send('response.function_call_arguments.done', {
                  type: 'response.function_call_arguments.done',
                  output_index: it.outputIndex,
                  item_id: it.itemId,
                  call_id: it.callId,
                  arguments: it.buf,
                })
                it.final = {
                  id: it.itemId,
                  type: 'function_call',
                  status: 'completed',
                  call_id: it.callId,
                  name: it.name,
                  arguments: it.buf,
                }
              }
              send('response.output_item.done', {
                type: 'response.output_item.done',
                output_index: it.outputIndex,
                item: it.final,
              })
              finalItems.push(it.final)
              break
            }
            case 'message_delta': {
              const sr = data.delta?.stop_reason
              if (sr === 'tool_use') stopReason = 'tool_use'
              else if (sr) stopReason = sr
              const u = data.usage
              if (typeof u?.output_tokens === 'number') usageOut = u.output_tokens
              if (typeof u?.input_tokens === 'number') usageIn = u.input_tokens
              break
            }
            case 'error': {
              send('response.failed', {
                type: 'response.failed',
                response: {
                  ...responseEnvelope('failed'),
                  error: data.error ?? { type: 'api_error', message: 'upstream error' },
                },
              })
              controller.close()
              return
            }
          }
        }
        void stopReason
        send('response.completed', { type: 'response.completed', response: responseEnvelope('completed') })
      } catch (err: any) {
        send('response.failed', {
          type: 'response.failed',
          response: { ...responseEnvelope('failed'), error: { type: 'api_error', message: String(err?.message ?? err) } },
        })
      } finally {
        controller.close()
      }
    },
  })
}
