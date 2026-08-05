/**
 * Codex provider (OpenAI Responses API, ChatGPT backend)
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
  IRLoss,
  WireProvider,
  WirePreparedRequest,
  ModelInfo,
  QuotaInfo,
} from '../types.js'
import { toCodexEffort } from '../thinking.js'
import type { AnthropicEventEmitter } from '../emitter.js'
import { iterSSE, tryParseJSON } from '../sse.js'
import type { TokenSource } from '../auth.js'
import { splitCachedFromTotalInput } from '../usage.js'

// 实测: ChatGPT 账号(含 k12 plan)经 backend-api/codex/responses 只接受这几个通用 slug;
// codex 专用 slug(*-codex / *-codex-max)仅对有 Codex 席位的 workspace 开放,k12 走这批会 400。
// 与 codex CLI 的 /model 选单对齐 (2026-07-30 实测)。注意 listModels 打的
// chatgpt.com/backend-api/codex/models 已落后于 CLI —— 它当天只回 gpt-5.4/5.5，
// 不含任何 5.6。所以这张表不是"fallback"，是比上游 /models 更新的权威表。
export const CODEX_MODELS = [
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', description: 'Latest frontier agentic coding model' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced agentic coding model for everyday work' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', description: 'Fast and affordable agentic coding model' },
  { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Strong model for everyday coding' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', description: 'Small, fast, cost-efficient for simpler coding' },
  { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark', description: 'Ultra-fast coding model' },
] as const

export const DEFAULT_CODEX_MODEL = 'gpt-5.6-sol'

export function isCodexModel(model: string): boolean {
  return CODEX_MODELS.some(m => m.id === model)
}

export function mapClaudeModelToCodex(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL
  if (isCodexModel(claudeModel)) return claudeModel
  // 按能力档位对齐, 不按版本号: opus→frontier, sonnet→balanced, haiku→fast/cheap
  const lower = claudeModel.toLowerCase()
  if (lower.includes('opus')) return 'gpt-5.6-sol'
  if (lower.includes('sonnet')) return 'gpt-5.6-terra'
  if (lower.includes('haiku')) return 'gpt-5.6-luna'
  return DEFAULT_CODEX_MODEL
}

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

function extractAccountId(token: string): string {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid Codex JWT (expected 3 parts)')
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf-8'))
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
  if (!accountId) throw new Error('Codex JWT missing chatgpt_account_id claim')
  return String(accountId)
}

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'

export interface CodexOpts {
  accessToken?: string
  source?: TokenSource
  /** Standard OpenAI Responses endpoint, used without ChatGPT account headers. */
  responsesBaseURL?: string
  apiKey?: string
  model?: string
  authScheme?: 'bearer' | 'x-api-key'
}

export function createCodexProvider(opts: CodexOpts): WireProvider {
  let accessToken = opts.accessToken || ''
  let accountId = ''
  let codexModelCache = DEFAULT_CODEX_MODEL
  const responsesCompat = typeof opts.responsesBaseURL === 'string' && opts.responsesBaseURL.length > 0

  return {
    name: 'codex',

    async prepare(): Promise<void> {
      if (responsesCompat) return
      if (opts.source) {
        accessToken = await opts.source.token()
      }
      accountId = extractAccountId(accessToken)
    },

    async buildRequest(req: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const codexModel = responsesCompat
        ? opts.model ?? req.model ?? DEFAULT_CODEX_MODEL
        : mapClaudeModelToCodex(req.model ?? null)
      codexModelCache = codexModel
      const instructions = systemPromptToString(req.system)
      const input = responsesCompat
        ? translateMessagesForResponses(req.messages)
        : translateMessages(req.messages)

      const body: Record<string, unknown> = {
        model: codexModel,
        store: false,
        stream: true,
        instructions,
        input,
        tool_choice: tool_choice_to_codex(req.tool_choice),
        parallel_tool_calls: true,
      }
      if (req.tools && req.tools.length > 0) body.tools = translateTools(req.tools)
      // IR 的 max_tokens 在此丢弃: Codex Responses 端点现已拒收 max_output_tokens
      // (400 "Unsupported parameter: max_output_tokens")，且无等价替代参数。
      // 客户端传的上限对 codex 出口无效——由上游自行截断。丢弃本身没得选，但不能悄悄丢：
      // 客户端设了上限、以为生效了，实际零作用，此前没有任何地方告知。
      const losses: IRLoss[] = []
      if (typeof req.max_tokens === 'number') {
        losses.push({
          stage: 'outbox',
          provider: 'codex',
          path: '$.max_tokens',
          kind: 'dropped',
          detail:
            `client asked for max_tokens=${req.max_tokens}; the Codex Responses endpoint rejects ` +
            'max_output_tokens (400 "Unsupported parameter") and has no equivalent, so the output ' +
            'length limit is not enforced on this route — upstream truncates on its own',
        })
      }
      const effort = toCodexEffort(req.reasoning)
      if (effort) body.reasoning = { effort }
      if (req.serviceTier?.tier === 'priority') body.service_tier = 'priority'

      return {
        url: responsesCompat
          ? `${opts.responsesBaseURL!.replace(/\/$/, '')}/responses`
          : CODEX_ENDPOINT,
        headers: responsesCompat
          ? {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              ...(opts.authScheme === 'x-api-key'
                ? { 'x-api-key': opts.apiKey ?? '' }
                : { Authorization: `Bearer ${opts.apiKey ?? ''}` }),
            }
          : {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              Authorization: `Bearer ${accessToken}`,
              'chatgpt-account-id': accountId,
              // 实测: 真实 codex CLI 的 originator 是 codex_cli_rs, 后端据此放行; 用别的值会连同
              // model 校验一起走到 400。session_id 每请求一个 uuid, 与真实 wire 对齐。
              originator: 'codex_cli_rs',
              'User-Agent': 'codex_cli_rs/0.58.0',
              session_id: crypto.randomUUID(),
              'OpenAI-Beta': 'responses=experimental',
            },
        body: JSON.stringify(body),
        losses,
      }
    },

    async parseStream(response: Response, emitter: AnthropicEventEmitter): Promise<void> {
      emitter.start({ model: codexModelCache })
      let hadTools = false
      let fallbackToolCounter = 0
      let upstreamErrorSurfaced = false
      // Responses 流必须以 response.completed / response.failed / error 之一收尾。
      // 一个都没等到就意味着流被掐断，绝不能当成正常结束(见循环后的兜底)。
      let sawTerminal = false
      const toolCalls = new Map<string, { order: number; id: string; name: string; arguments: string }>()
      const toolKeyByOutputIndex = new Map<number, string>()

      const resolveToolKey = (data: any): string => {
        if (typeof data.item_id === 'string' && data.item_id.length > 0) return data.item_id
        if (typeof data.output_index === 'number') {
          const existing = toolKeyByOutputIndex.get(data.output_index)
          if (existing) return existing
          const generated = `output_${data.output_index}`
          toolKeyByOutputIndex.set(data.output_index, generated)
          return generated
        }
        if (typeof data.call_id === 'string' && data.call_id.length > 0) return data.call_id
        return `tool_${fallbackToolCounter++}`
      }

      const upsertToolCall = (
        key: string,
        patch: { outputIndex?: number; callId?: string; name?: string; argumentsDelta?: string; argumentsFull?: string },
      ): void => {
        const current = toolCalls.get(key) ?? {
          order: typeof patch.outputIndex === 'number' ? patch.outputIndex : toolCalls.size,
          id: patch.callId || `call_${toolCalls.size}_${Date.now().toString(36)}`,
          name: patch.name || '',
          arguments: '',
        }
        if (typeof patch.outputIndex === 'number') current.order = patch.outputIndex
        if (patch.callId) current.id = patch.callId
        if (patch.name) current.name = patch.name
        if (typeof patch.argumentsFull === 'string') current.arguments = patch.argumentsFull
        if (typeof patch.argumentsDelta === 'string') current.arguments += patch.argumentsDelta
        toolCalls.set(key, current)
      }

      const emitBufferedToolCalls = (): void => {
        if (toolCalls.size === 0) return
        const sorted = [...toolCalls.values()].sort((left, right) => left.order - right.order)
        for (const tool of sorted) {
          if (!tool.id || !tool.name) continue
          emitter.openToolUse(tool.id, tool.name)
          if (tool.arguments.length > 0) emitter.pushToolArgsDelta(tool.arguments)
          emitter.closeBlock()
        }
        toolCalls.clear()
        toolKeyByOutputIndex.clear()
      }

      for await (const evt of iterSSE(response)) {
        const data = tryParseJSON<any>(evt.data)
        if (!data) {
          // data 段解析不出 JSON：上游要么换了编码，要么流被截断在半个事件上。
          // 静默丢掉的话它就永远不存在了。
          emitter.unhandled(evt.event ?? '<unparseable>', evt.data)
          continue
        }
        const t = data.type as string

        switch (t) {
          // Codex/ChatGPT rejects some requests mid-stream instead of via HTTP status —
          // most commonly `context_length_exceeded` once the accumulated session context
          // (agent transcript, tool outputs, images) exceeds the model's window. This
          // surfaces as EITHER a top-level `{type:"error", error:{...}}` SSE event OR a
          // `response.failed` event carrying `response.error`. Before this handler existed
          // neither shape matched any case in this switch, so the loop silently skipped it
          // and fell through to `emitter.finish()` with zero content/tool calls and
          // stop_reason 'end_turn' — a 200-shaped response that LOOKS successful but is
          // empty. The calling harness (omp) has no way to tell "nothing to say" from
          // "upstream rejected this" and retries blindly until it hits its own retry cap,
          // surfacing only "Assistant returned empty stop after retry cap" with zero
          // indication of the real cause (verified live: 126 silent context_length_exceeded
          // failures in one day of gateway traffic, all invisible to the caller).
          // Fix: surface the real upstream error as visible assistant text so the harness
          // (and the human) can see WHY and act (compact, `/shake images`, switch models) —
          // this is a deterministic failure (the same oversized payload will fail identically
          // on retry), so we do NOT mark the turn unusable; that would only add pointless
          // retry latency with the exact same result.
          case 'error': {
            sawTerminal = true
            if (upstreamErrorSurfaced) break // response.failed already surfaced the same rejection
            upstreamErrorSurfaced = true
            const err = data.error ?? {}
            const message = typeof err.message === 'string' && err.message
              ? err.message
              : 'unknown upstream error'
            const code = typeof err.code === 'string' ? err.code : (typeof err.type === 'string' ? err.type : 'error')
            emitter.pushText(`[gateway] Codex upstream rejected this request (${code}): ${message}`)
            emitter.setStopReason('end_turn')
            break
          }
          case 'response.failed': {
            sawTerminal = true
            if (upstreamErrorSurfaced) break // top-level `error` event already surfaced this
            upstreamErrorSurfaced = true
            const err = data.response?.error ?? {}
            const message = typeof err.message === 'string' && err.message
              ? err.message
              : 'unknown upstream error'
            const code = typeof err.code === 'string' ? err.code : 'response.failed'
            emitter.pushText(`[gateway] Codex upstream rejected this request (${code}): ${message}`)
            emitter.setStopReason('end_turn')
            break
          }
          case 'response.output_item.added': {
            const item = data.item
            if (item?.type === 'function_call') {
              hadTools = true
              const outputIndex = typeof data.output_index === 'number' ? data.output_index : undefined
              const key = typeof item.id === 'string' && item.id.length > 0
                ? item.id
                : resolveToolKey({ ...data, call_id: item.call_id })
              if (typeof outputIndex === 'number') toolKeyByOutputIndex.set(outputIndex, key)
              upsertToolCall(key, {
                outputIndex,
                callId: item.call_id,
                name: item.name,
                argumentsDelta: typeof item.arguments === 'string' ? item.arguments : undefined,
              })
            }
            break
          }
          case 'response.output_text.delta': {
            const text = data.delta as string | undefined
            if (typeof text === 'string' && text.length > 0) {
              emitter.pushText(text)
              emitter.addOutputTokens(1)
            }
            break
          }
          case 'response.reasoning.delta':
          case 'response.reasoning_summary_text.delta': {
            const text = (data.delta ?? data.text) as string | undefined
            if (typeof text === 'string' && text.length > 0) {
              emitter.pushThinking(text)
              emitter.addOutputTokens(1)
            }
            break
          }
          case 'response.function_call_arguments.delta': {
            const delta = data.delta as string | undefined
            if (typeof delta === 'string' && delta.length > 0) {
              hadTools = true
              const outputIndex = typeof data.output_index === 'number' ? data.output_index : undefined
              upsertToolCall(resolveToolKey(data), {
                outputIndex,
                callId: data.call_id,
                name: data.name,
                argumentsDelta: delta,
              })
            }
            break
          }
          case 'response.function_call_arguments.done': {
            hadTools = true
            const outputIndex = typeof data.output_index === 'number' ? data.output_index : undefined
            upsertToolCall(resolveToolKey(data), {
              outputIndex,
              callId: data.call_id,
              name: data.name,
              argumentsFull: typeof data.arguments === 'string' ? data.arguments : undefined,
            })
            break
          }
          case 'response.output_item.done': {
            const item = data.item
            if (item?.type === 'function_call') {
              hadTools = true
              const outputIndex = typeof data.output_index === 'number' ? data.output_index : undefined
              const key = typeof item.id === 'string' && item.id.length > 0
                ? item.id
                : resolveToolKey({ ...data, call_id: item.call_id })
              if (typeof outputIndex === 'number') toolKeyByOutputIndex.set(outputIndex, key)
              upsertToolCall(key, {
                outputIndex,
                callId: item.call_id,
                name: item.name,
                argumentsFull: typeof item.arguments === 'string' ? item.arguments : undefined,
              })
            } else {
              emitter.closeBlock()
            }
            break
          }
          case 'response.completed': {
            sawTerminal = true
            const usage = data.response?.usage
            if (usage) {
              // Responses API 的 input_tokens **含** input_tokens_details.cached_tokens
              // (实测 PROTOCOL_REFERENCE §11: input_tokens 18661 里 cached 17792)。
              // IR 用 Anthropic 语义(input 不含缓存)，所以这里先拆出来，出口再加回去。
              const split = splitCachedFromTotalInput(
                usage.input_tokens,
                usage.input_tokens_details?.cached_tokens,
              )
              emitter.setUsage({
                input: split.input,
                output: usage.output_tokens,
                cacheRead: split.cacheRead,
              })
            }
            break
          }
          // 生命周期/心跳事件：确实不携带任何 IR 信息，丢掉是对的，但必须**显式**声明
          // 丢，否则和"上游加了个新事件、我们没接住"混在同一个缺省分支里分不出来。
          // 这批全部来自真实流量统计(2026-08-01..04 网关日志)，不是照文档猜的：
          // response.created 432 / response.in_progress 365 / content_part.added 521 /
          // content_part.done 521 / output_text.done 521(正文已由 .delta 累计) /
          // keepalive 12(codex 自己的心跳，文档没写)。
          case 'response.created':
          case 'response.in_progress':
          case 'response.content_part.added':
          case 'response.content_part.done':
          case 'response.output_text.done':
          case 'keepalive':
            break
          default:
            emitter.unhandled(t || '<no-type>', data)
        }
      }

      if (hadTools) emitBufferedToolCalls()
      emitter.setStopReason(hadTools ? 'tool_use' : 'end_turn')
      // 流走完却一个终止事件都没见过 = 上游把连接掐了。此前这里直接 finish()，产出的是
      // stop_reason:'end_turn' 的空回合 —— 一个"看起来成功"的 200，与真正的空回答无法
      // 区分。显式报错是这次改造对客户端可见行为的唯一变化。
      if (!sawTerminal) {
        emitter.error({
          type: 'api_error',
          message:
            '[gateway] codex upstream stream ended without a terminal event ' +
            '(expected response.completed / response.failed / error); the turn is truncated',
        })
      }
      emitter.finish()
    },

    async listModels(): Promise<ModelInfo[]> {
      if (responsesCompat) return []
      const res = await fetch('https://chatgpt.com/backend-api/codex/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
          'OpenAI-Beta': 'responses=experimental',
        },
      })
      if (!res.ok) {
        return CODEX_MODELS.map(m => ({
          id: m.id,
          name: m.label,
        }))
      }
      const data = (await res.json()) as any
      const list = data.models || []
      return list.map((m: any) => ({
        id: m.slug || m.id,
        name: m.display_name || m.slug || m.id,
      }))
    },

    async getQuota(): Promise<QuotaInfo> {
      if (opts.source && opts.source.getQuota) {
        return opts.source.getQuota()
      }
      return {
        planType: 'codex-free',
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
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text!)
    .join('\n')
}

function tool_choice_to_codex(
  choice: AnthropicMessagesRequest['tool_choice'],
): string | Record<string, unknown> {
  if (!choice) return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', name: choice.name }
  }
  return 'auto'
}

function translateTools(tools: AnthropicTool[]): Array<Record<string, unknown>> {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description ?? '',
    parameters: t.input_schema ?? { type: 'object', properties: {} },
    strict: null,
  }))
}

function translateMessages(
  messages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let counter = 0

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const parts: Array<Record<string, unknown>> = []
      for (const block of msg.content as AnthropicContentBlock[]) {
        if (block.type === 'tool_result') {
          const callId = block.tool_use_id ?? `call_${counter++}`
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map(c => {
                if (c.type === 'text') return c.text ?? ''
                if (c.type === 'image' && c.source && c.source.type === 'base64') {
                  return `![image](data:${c.source.media_type};base64,${c.source.data})`
                }
                return ''
              })
              .filter(Boolean)
              .join('\n')
          }
          out.push({ type: 'function_call_output', call_id: callId, output: outputText })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'input_text', text: block.text })
        } else if (
          block.type === 'image' &&
          block.source &&
          (block.source as any).type === 'base64'
        ) {
          const src = block.source as any
          parts.push({
            type: 'input_image',
            image_url: `data:${src.media_type};base64,${src.data}`,
          })
        }
      }
      if (parts.length === 1 && parts[0]!.type === 'input_text') {
        out.push({ role: 'user', content: parts[0]!.text })
      } else if (parts.length > 0) {
        out.push({ role: 'user', content: parts })
      }
    } else {
      // assistant
      for (const block of msg.content as AnthropicContentBlock[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          out.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text, annotations: [] }],
            status: 'completed',
          })
        } else if (block.type === 'tool_use') {
          out.push({
            type: 'function_call',
            call_id: block.id ?? `call_${counter++}`,
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
    }
  }

  return out
}

/**
 * ChatGPT's private Codex endpoint accepts shorthand `{role, content}` input
 * items.  Public Responses-compatible relays validate the documented envelope
 * and require every message item to carry `type: "message"`.
 */
function translateMessagesForResponses(
  messages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  return translateMessages(messages).map(item => {
    if (typeof item.type === 'string') return item
    const role = item.role
    if (role !== 'user' && role !== 'assistant' && role !== 'system') return item
    const content = item.content
    if (typeof content === 'string') {
      return {
        type: 'message',
        role,
        content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }],
      }
    }
    return { type: 'message', role, content }
  })
}
