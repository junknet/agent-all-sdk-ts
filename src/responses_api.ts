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
import { parseReasoningEffort } from './thinking.js'
import { parseServiceTier } from './service_tier.js'
import { normalizeToolTurns, resolveDefaultMaxTokens } from './anthropic_constraints.js'
import { createUsageCollector, toResponsesUsage } from './usage.js'

// ── id generation ────────────────────────────────────────────────────
let idCounter = 0
function genId(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}`
}

// ── reasoning effort → Anthropic thinking budget ─────────────────────
// ── data: URL → Anthropic base64 image source ────────────────────────
function dataUrlToImageBlock(imageUrl: string): AnthropicContentBlock | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(imageUrl)
  if (!m) return null
  return { type: 'image', source: { type: 'base64', media_type: m[1]!, data: m[2]! } }
}

// ── namespaced (tool-search grouped) tool flattening ─────────────────
// codex exposes sub-agents (`multi_agent_v1`) and every MCP server as `type:"namespace"`
// tool groups (provider capability `namespace_tools`, default-on for any provider). The
// Gemini backend has no namespace concept — it only knows flat JSON function calls — so we
// expand each group into standalone function tools named `${namespace}${member}` (codex's
// own ToolName flat form), then reverse that on the response edge. Reversal is by an
// explicit per-request map, not by re-parsing the flat string: codex dispatches on the
// (namespace, short-name) pair (`router` checks `tool_name.name == "spawn_agent"`), so the
// returned function_call MUST carry `namespace` + the short member name, never the flat one.
export type NamespaceToolMap = Map<string, { namespace: string; name: string }>

function flattenNamespacedName(namespace: string, name: string): string {
  return `${namespace}${name}`
}

// Gemini hard-caps a request at 128 function declarations; the stricter Pro backends reject
// (400 INVALID_ARGUMENT) above it while the lenient Flash backends silently keep only the
// first N. Flattening every namespace blows past this (codex ships ~217 with all MCP apps).
// Plain tools + sub-agents are always kept; remaining namespaces are admitted whole-group in
// priority order until the budget is spent, and the rest are reported via droppedNamespaces.
const MAX_GEMINI_TOOLS: number = (() => {
  const v = Number(process.env.AGENT_GATEWAY_MAX_GEMINI_TOOLS)
  return Number.isFinite(v) && v > 0 ? v : 128
})()

// ── tools: Responses tool defs → Anthropic tool defs ─────────────────
function decodeTools(
  tools: any[] | undefined,
  namespaceTools: NamespaceToolMap,
  droppedNamespaces: string[],
): AnthropicTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out: AnthropicTool[] = []
  const groups: Array<{ namespace: string; members: any[] }> = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    if (t.type === 'namespace' && Array.isArray(t.tools)) {
      // Each member carries its full function schema inline; defer flattening until budgeting.
      groups.push({
        namespace: String(t.name ?? ''),
        members: t.tools.filter((m: any) => m && typeof m === 'object' && m.name),
      })
    } else if (t.type === 'function' || t.name) {
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
  // Sub-agents first (the whole point of namespacing here); rest keep codex's order, which
  // already trails the bulky built-in apps (codex_apps github/drive) so they drop first.
  groups.sort((a, b) => Number(b.namespace === 'multi_agent_v1') - Number(a.namespace === 'multi_agent_v1'))
  for (const g of groups) {
    if (out.length + g.members.length > MAX_GEMINI_TOOLS) {
      droppedNamespaces.push(`${g.namespace}(${g.members.length})`)
      continue
    }
    for (const m of g.members) {
      const flat = flattenNamespacedName(g.namespace, m.name)
      namespaceTools.set(flat, { namespace: g.namespace, name: m.name })
      out.push({
        name: flat,
        description: m.description ?? '',
        input_schema: m.parameters ?? { type: 'object', properties: {} },
      })
    }
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
export function decodeResponsesToAnthropic(req: any): {
  request: AnthropicMessagesRequest
  namespaceTools: NamespaceToolMap
  droppedNamespaces: string[]
} {
  const namespaceTools: NamespaceToolMap = new Map()
  const droppedNamespaces: string[] = []
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

  // Responses 规范允许 input 为字符串简写(等价单条 user 文本)。不归一化的话
  // 它会被当成空数组，请求到上游变成无 input → 400 missing_required_parameter。
  const input = Array.isArray(req.input)
    ? req.input
    : typeof req.input === 'string' && req.input.length > 0
      ? [req.input]
      : []
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
      case 'function_call': {
        // Replayed namespaced calls carry a separate `namespace` field; codex may serialize
        // `name` as either the short member or the full flat form. Normalize to the same flat
        // name the tool defs use so the Gemini backend sees a consistent symbol across turns.
        const ns = typeof item.namespace === 'string' && item.namespace ? item.namespace : undefined
        const rawName = typeof item.name === 'string' ? item.name : ''
        const shortName = ns && rawName.startsWith(ns) ? rawName.slice(ns.length) : rawName
        const flatName = ns ? flattenNamespacedName(ns, shortName) : rawName
        if (ns) namespaceTools.set(flatName, { namespace: ns, name: shortName })
        push('assistant', {
          type: 'tool_use',
          id: item.call_id ?? item.id ?? genId('call'),
          name: flatName,
          input: (tryParseJSON<Record<string, unknown>>(item.arguments ?? '{}') ?? {}) as Record<
            string,
            unknown
          >,
        })
        break
      }
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
  // 按 role 分组只保证了"连续同角色合并"，保证不了工具回合的不变量：codex 在自动压缩
  // 之后会重放出 function_call 被砍、function_call_output 还在的历史(孤儿 tool_result，
  // 上游 400 "unexpected `tool_use_id` found in `tool_result` blocks")，反过来也会留下
  // 没有结果的 function_call。与另外两个入口共用同一套归一。
  normalizeToolTurns(messages)

  const out: AnthropicMessagesRequest = {
    model: req.model,
    messages,
    stream: true,
  }
  if (systemTexts.length > 0) out.system = systemTexts.join('\n\n')
  const tools = decodeTools(req.tools, namespaceTools, droppedNamespaces)
  if (tools) out.tools = tools
  // codex CLI 根本不发 max_output_tokens(实测抓包 PROTOCOL_REFERENCE §11 的顶层字段
  // 里就没有这个键)，而 Anthropic Messages 的 max_tokens 是必填 —— 于是
  // codex --wire_api=responses 打任何 claude 模型，每一发都 400
  // "max_tokens: Field required"，整条 codex→claude 路由是全废的(实测 2026-08-03，
  // 用 §11 记录的真实请求体打 :8086 复现)。这里与 /v1/chat/completions 入口共用兜底值。
  out.max_tokens = req.max_output_tokens || resolveDefaultMaxTokens()
  if (typeof req.temperature === 'number') out.temperature = req.temperature
  if (typeof req.top_p === 'number') out.top_p = req.top_p
  const reasoning = parseReasoningEffort(req.reasoning) ??
    parseReasoningEffort(process.env.AGENT_GATEWAY_DEFAULT_EFFORT, 'gateway-default')
  if (reasoning) out.reasoning = reasoning
  const serviceTier = parseServiceTier(req.service_tier)
  if (serviceTier) out.serviceTier = serviceTier
  const tc = toolChoice(req.tool_choice)
  if (tc) out.tool_choice = tc
  return { request: out, namespaceTools, droppedNamespaces }
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
  namespace?: string
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
  namespaceTools?: NamespaceToolMap,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const responseId = genId('resp')
  const created = Math.floor(Date.now() / 1000)

  // anthropic block index → our output item state
  const items = new Map<number, OutItem>()
  const finalItems: Array<Record<string, unknown>> = []
  let outputCounter = 0
  // Responses 的 usage 形状与 Chat 不同(input_tokens/output_tokens)，换算走 usage.ts；
  // 缓存命中同样要算进 input_tokens —— codex 的缓存命中率极高(实测一轮 18661 里 17792
  // 是缓存)，漏掉的话 codex 侧看到的上下文占用只有真实值的零头。
  const usage = createUsageCollector()
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
        usage: toResponsesUsage(usage.snapshot()),
      })

      send('response.created', { type: 'response.created', response: responseEnvelope('in_progress') })
      send('response.in_progress', { type: 'response.in_progress', response: responseEnvelope('in_progress') })

      try {
        for await (const ev of iterSSE(anthropicResponse)) {
          const data = tryParseJSON<any>(ev.data)
          if (!data) continue
          // usage 字段名只认 usage.pickAnthropicUsage 那一处，message_start 与
          // message_delta 两处都由它统一识别。
          usage.observe(data)

          switch (data.type) {
            case 'message_start':
              break
            case 'content_block_start': {
              const idx: number = data.index
              const cb = data.content_block ?? {}
              if (cb.type === 'tool_use') {
                // Reverse namespace flattening: a flat name we minted on the request edge maps
                // back to (namespace, short member) — codex dispatches on that pair, not the
                // flat string. Plain tools (not in the map) pass through unchanged.
                const flatName = cb.name ?? ''
                const nsEntry = namespaceTools?.get(flatName)
                const it: OutItem = {
                  outputIndex: outputCounter++,
                  itemId: genId('fc'),
                  kind: 'tool',
                  callId: cb.id ?? genId('call'),
                  name: nsEntry ? nsEntry.name : flatName,
                  namespace: nsEntry?.namespace,
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
                    ...(it.namespace ? { namespace: it.namespace } : {}),
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
                  ...(it.namespace ? { namespace: it.namespace } : {}),
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
