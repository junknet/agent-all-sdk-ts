/**
 * Antigravity provider (Gemini via Google CloudCode)
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  WireProvider,
  WirePreparedRequest,
  ModelInfo,
  QuotaInfo,
} from '../types.js'
import type { AnthropicEventEmitter } from '../emitter.js'
import { iterSSE, tryParseJSON } from '../sse.js'

function getSessionId(): string {
  return Date.now().toString()
}

// ── OAuth ───────────────────────────────────────────────────────────

interface TokenStore {
  access_token: string
  token_type?: string
  refresh_token?: string
  scope?: string
  id_token?: string
  expiry_date?: number
}

const CLIENT_ID =
  process.env.ANTIGRAVITY_CLIENT_ID ||
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
const CLIENT_SECRET =
  process.env.ANTIGRAVITY_CLIENT_SECRET || 'ANTIGRAVITY_CLIENT_SECRET_REMOVED'
function getGeminiTokenPath(): string {
  const customDir = process.env.GATEWAY_CREDENTIALS_DIR
  if (customDir) {
    return path.join(customDir, 'gemini_oauth_creds.json')
  }
  const home = os.homedir()
  const isWin = process.platform === 'win32'
  if (isWin && process.env.APPDATA) {
    const winPath = path.join(process.env.APPDATA, 'gemini', 'oauth_creds.json')
    if (fs.existsSync(winPath)) return winPath
  }
  return path.join(home, '.gemini', 'oauth_creds.json')
}

const TOKEN_PATH = getGeminiTokenPath()
// agy(Antigravity CLI 1.1.8) 打的是生产 host；daily- 那个是预发，两者模型表已不同步。
const CC_HOST = process.env.ANTIGRAVITY_HOST ?? 'cloudcode-pa.googleapis.com'

const USER_AGENT = 'antigravity/fantasy/1.0.0 linux/amd64'
const ENDPOINT =
  `https://${CC_HOST}/v1internal:streamGenerateContent?alt=sse`

export async function getOrRefreshAccessToken(): Promise<string> {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      `No usable credentials found at ${TOKEN_PATH}. Please run 'gemini login' first.`,
    )
  }
  const store = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) as TokenStore
  const expired =
    !store.access_token || !store.expiry_date || Date.now() + 60_000 > store.expiry_date
  if (!expired) return store.access_token
  if (!store.refresh_token) throw new Error('access_token expired and no refresh_token available')

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: store.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  })
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Token refresh failed: ${res.status} ${errText}`)
  }
  const data = (await res.json()) as any
  store.access_token = data.access_token
  if (data.refresh_token) store.refresh_token = data.refresh_token
  if (data.expires_in) store.expiry_date = Date.now() + data.expires_in * 1000
  if (data.scope) store.scope = data.scope
  if (data.id_token) store.id_token = data.id_token
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(store, null, 2), 'utf8')
  return store.access_token
}

const cachedProjectsByToken = new Map<string, string>()

export async function getProject(accessToken: string): Promise<string> {
  const cached = cachedProjectsByToken.get(accessToken)
  if (cached) return cached
  const res = await fetch(
    `https://${CC_HOST}/v1internal:loadCodeAssist`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY' } }),
    },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`loadCodeAssist failed: ${res.status} ${text}`)
  }
  const data = (await res.json()) as any
  // 2026-07-30: loadCodeAssist 不再回 cloudaicompanionProject —— free-tier 被划入
  // ineligibleTiers(UNSUPPORTED_CLIENT / UNSUPPORTED_LOCATION)，仅剩的 standard-tier
  // 标着 userDefinedCloudaicompanionProject:true，服务端不再自动分配。
  // Antigravity CLI 1.1.8 在同样情况下用固定串 "default-cli-project"
  // (其日志: "Backend project ID updated dynamically to: default-cli-project")，
  // 且 fetchAvailableModels / streamGenerateContent 实测接受它。
  // 抛错会打死整条出口，故降级为该默认值；可用 ANTIGRAVITY_PROJECT 覆盖。
  const project =
    data.cloudaicompanionProject ||
    process.env.ANTIGRAVITY_PROJECT ||
    'default-cli-project'
  cachedProjectsByToken.set(accessToken, project)
  // Prevent memory leaks in long-running gateway processes
  if (cachedProjectsByToken.size > 2048) {
    const firstKey = cachedProjectsByToken.keys().next().value
    if (firstKey !== undefined) cachedProjectsByToken.delete(firstKey)
  }
  return project
}

// ── Schema cleaning ─────────────────────────────────────────────────────

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'items',
  'required',
  'description',
  'enum',
  'nullable',
])

const GEMINI_TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
}

function cleanGeminiSchema(schema: any): any {
  if (schema === null || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map(cleanGeminiSchema)

  const cleaned: any = {}

  let type = schema.type
  if (Array.isArray(type)) {
    if (type.includes('null')) cleaned.nullable = true
    type = type.find((t: string) => t !== 'null')
  }
  if (typeof type === 'string') {
    cleaned.type = GEMINI_TYPE_MAP[type.toLowerCase()] ?? type.toUpperCase()
  }

  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) continue
    if (key === 'type') continue

    if (key === 'properties') {
      const props = schema[key]
      const cleanedProps: any = {}
      if (props && typeof props === 'object' && !Array.isArray(props)) {
        for (const name of Object.keys(props)) cleanedProps[name] = cleanGeminiSchema(props[name])
      }
      cleaned[key] = cleanedProps
    } else if (key === 'items') {
      cleaned[key] = cleanGeminiSchema(schema[key])
    } else {
      cleaned[key] = schema[key]
    }
  }

  return cleaned
}

// ── Model alias ──────────────────────────────────────────────────────

export const ANTIGRAVITY_MODEL_ALIAS: Readonly<Record<string, string>> = Object.freeze({
  // 友好名 → 具体档位。3.6 默认给 high(budget 10000)，与 agy 的 (High) 一致。
  'gemini-3.6-flash': 'gemini-3.6-flash-high',
  'gemini-3.5-flash-high': 'gemini-3-flash-agent',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-extra-low',
  'gemini-3.5-flash': 'gemini-3.5-flash-low',
  // The agent endpoint only accepts the `-agent` backend ids; the friendly Pro id
  // `gemini-3.1-pro-high` 400s (INVALID_ARGUMENT). Route it to the callable Pro agent —
  // same enum tier (M16, budget 10001) — so codex-g-max works. Mirrors flash-high→flash-agent.
  'gemini-3.1-pro-high': 'gemini-pro-agent',
})

export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3.6-flash-high'

export function resolveAntigravityModel(input: string | undefined): string {
  const name = (input ?? '').trim() || ANTIGRAVITY_DEFAULT_MODEL
  return ANTIGRAVITY_MODEL_ALIAS[name] ?? name
}

export interface AntigravityModelMeta {
  enum: string
  budget: number
}

// 上游 fetchAvailableModels 报的 maxOutputTokens：gemini 全系 65536、CloudCode 侧
// Claude 64000。取保守的 65536 作统一上限。
const ANTIGRAVITY_MAX_OUTPUT = 65536
// 思考预算之外至少要留给正文的额度。CloudCode 把 thinkingBudget 算在 maxOutputTokens
// 里，客户端给的 max_tokens 若不大于 budget，思考会把额度吃光 —— 上游返回 200 但正文
// 为空，看起来像"模型坏了"(实测 max_tokens=20 + budget=10000 就是全空)。
const ANTIGRAVITY_MIN_VISIBLE = 4096

// 全表于 2026-07-30 用 cloudcode-pa 的 fetchAvailableModels 逐项核过(project=
// "default-cli-project")。要重核: 打 :fetchAvailableModels，读每个 model 的
// `model`(enum) 与 `thinkingBudget`。上游会改 enum —— 本次就发现
// gemini-3-flash-agent 从 M132 漂到 M84。
export const ANTIGRAVITY_MODEL_META: Readonly<Record<string, AntigravityModelMeta>> = Object.freeze({
  // Gemini 3.6 Flash：当前最新档，ctx 1,048,576 / maxOut 65,536
  'gemini-3.6-flash-high': { enum: 'MODEL_PLACEHOLDER_M71', budget: 10000 },
  'gemini-3.6-flash-medium': { enum: 'MODEL_PLACEHOLDER_M72', budget: 4000 },
  'gemini-3.6-flash-low': { enum: 'MODEL_PLACEHOLDER_M73', budget: 1000 },
  // tiered = 动态思考预算(budget -1)，由上游自行分配
  'gemini-3.6-flash-tiered': { enum: 'MODEL_PLACEHOLDER_M196', budget: -1 },
  // 同一 CloudCode 出口也供 Anthropic(走 Vertex) 与 GPT-OSS，ctx 250k / 131k
  'claude-sonnet-4-6': { enum: 'MODEL_PLACEHOLDER_M35', budget: 1024 },
  'claude-opus-4-6-thinking': { enum: 'MODEL_PLACEHOLDER_M26', budget: 1024 },
  'gpt-oss-120b-medium': { enum: 'MODEL_OPENAI_GPT_OSS_120B_MEDIUM', budget: 8192 },
  'gemini-3-flash': { enum: 'MODEL_PLACEHOLDER_M18', budget: -1 },
  'gemini-3-flash-agent': { enum: 'MODEL_PLACEHOLDER_M84', budget: 10000 },
  'gemini-3.5-flash-low': { enum: 'MODEL_PLACEHOLDER_M20', budget: 4000 },
  'gemini-3.5-flash-extra-low': { enum: 'MODEL_PLACEHOLDER_M187', budget: 1000 },
  'gemini-3.1-pro-high': { enum: 'MODEL_PLACEHOLDER_M37', budget: 10001 },
  'gemini-3.1-pro-low': { enum: 'MODEL_PLACEHOLDER_M36', budget: 1001 },
  'gemini-pro-agent': { enum: 'MODEL_PLACEHOLDER_M16', budget: 10001 },
  'gemini-2.5-pro': { enum: 'MODEL_GOOGLE_GEMINI_2_5_PRO', budget: 1024 },
})

// Models with NO reasoning capability (PROTOCOL_REFERENCE §3.1, think=✗). Sending a
// thinkingConfig to these 400s, so the gateway strips reasoning for them regardless of
// what the client asked — transparent compat: the client's effort param is meaningless.
export const ANTIGRAVITY_NO_THINKING: ReadonlySet<string> = new Set([
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-image',
  'gemini-2.5-flash-lite',
])

function trajectoryFromRequestID(requestID: string): string {
  const parts = requestID.split('/')
  return parts.length >= 2 ? parts[parts.length - 2]! : requestID
}

const HIDDEN_REASONING_INSTRUCTION =
  'Internal reasoning must remain hidden. Never emit visible chain-of-thought, ' +
  'thinking prefixes, or scratchpad labels such as 思考:, Thought:, Thinking:, or <think>. ' +
  'If the user requests an exact reply, output only that exact reply.'

// ── Provider ─────────────────────────────────────────────────────────

export interface AntigravityOpts {
  model: string
}

export function createAntigravityProvider(opts: AntigravityOpts): WireProvider {
  const fallbackModel = resolveAntigravityModel(process.env.ANTIGRAVITY_MODEL || opts.model)
  let accessToken = ''
  let project = ''

  return {
    name: 'antigravity',

    async prepare(): Promise<void> {
      accessToken = await getOrRefreshAccessToken()
      project = await getProject(accessToken)
    },

    async buildRequest(req: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const targetModel = resolveAntigravityModel(req.model) || fallbackModel
      const systemTexts = systemPromptToTexts(req.system)
      const toolNameByID = collectToolNamesById(req.messages)
      const contents = translateMessages(req.messages, toolNameByID)

      const innerRequest: Record<string, unknown> = {
        contents,
        sessionId: getSessionId(),
      }
      const allSystemTexts = [HIDDEN_REASONING_INSTRUCTION, ...systemTexts]
      innerRequest.systemInstruction = { parts: [{ text: allSystemTexts.join('\n\n') }] }

      const meta = ANTIGRAVITY_MODEL_META[targetModel]
      const genCfg: Record<string, unknown> = {}
      // 先按模型档位的思考预算抬高下限，再按上游上限封顶；客户端没给就直接顶满。
      const gearBudget = meta && meta.budget > 0 ? meta.budget : 0
      const floor = gearBudget > 0 ? gearBudget + ANTIGRAVITY_MIN_VISIBLE : 0
      genCfg.maxOutputTokens = Math.min(
        ANTIGRAVITY_MAX_OUTPUT,
        Math.max(req.max_tokens ?? ANTIGRAVITY_MAX_OUTPUT, floor),
      )
      if (typeof req.temperature === 'number') genCfg.temperature = req.temperature
      if (typeof req.top_p === 'number') genCfg.topP = req.top_p
      if (Array.isArray(req.stop_sequences)) genCfg.stopSequences = req.stop_sequences

      // Reasoning is transparently reconciled at the gateway (the client's effort/thinking
      // is advisory — for Gemini the reasoning gear is encoded in the MODEL ID, not a
      // runtime param):
      //   - no-thinking models (flash-lite/image): strip reasoning entirely.
      //   - gear models (in META): the model's own budget WINS over the client. budget=-1
      //     means dynamic/adaptive → send includeThoughts but OMIT thinkingBudget (server
      //     self-paces). This is what gemini-3-flash does.
      //   - other thinking-capable models: honor the client's budget if provided.
      const thinkingEnabled = req.thinking?.type === 'enabled'
      if (!ANTIGRAVITY_NO_THINKING.has(targetModel) && (meta || thinkingEnabled)) {
        const thinkCfg: Record<string, unknown> = { includeThoughts: true }
        const budget = meta ? meta.budget : (thinkingEnabled ? req.thinking?.budget_tokens ?? 0 : 0)
        if (budget > 0) thinkCfg.thinkingBudget = budget // budget<=0 (incl. -1 dynamic) → omit
        genCfg.thinkingConfig = thinkCfg
      }
      if (Object.keys(genCfg).length > 0) innerRequest.generationConfig = genCfg

      if (req.tools && req.tools.length > 0) {
        innerRequest.tools = [
          {
            functionDeclarations: req.tools.map(t => ({
              name: t.name,
              description: t.description ?? '',
              parameters: cleanGeminiSchema(t.input_schema ?? { type: 'object', properties: {} }),
            })),
          },
        ]

        const tc = req.tool_choice
        const cfg: Record<string, unknown> = { mode: 'VALIDATED' }
        if (tc) {
          cfg.mode =
            tc.type === 'any' ? 'ANY' : tc.type === 'none' ? 'NONE' : tc.type === 'tool' ? 'ANY' : 'AUTO'
          if (tc.type === 'tool' && tc.name) cfg.allowedFunctionNames = [tc.name]
        }
        innerRequest.toolConfig = { functionCallingConfig: cfg }
      }

      const sessionID = getSessionId()
      const requestID = `agent/${sessionID}/${Date.now()}/${Math.random().toString(16).slice(2, 10)}/2`

      const labels: Record<string, unknown> = {
        used_claude: 'false',
        used_claude_conservative: 'false',
        trajectory_id: trajectoryFromRequestID(requestID),
        last_step_index: '0',
      }
      if (meta && meta.enum) labels.model_enum = meta.enum
      innerRequest.labels = labels

      const body = {
        project,
        requestId: requestID,
        request: innerRequest,
        model: targetModel,
        userAgent: 'antigravity',
        requestType: 'agent',
      }

      return {
        url: ENDPOINT,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
      }
    },

    async parseStream(response: Response, emitter: AnthropicEventEmitter): Promise<void> {
      emitter.start({ model: fallbackModel })
      let hadTools = false
      let lastFinishReason = ''
      let thinkingBuf = ''

      for await (const evt of iterSSE(response)) {
        const chunk = tryParseJSON<any>(evt.data)
        if (!chunk) continue

        const usage = chunk.response?.usageMetadata
        if (usage) {
          emitter.setUsage({
            input: usage.promptTokenCount,
            output: usage.candidatesTokenCount,
          })
        }

        const candidates = chunk.response?.candidates
        if (!Array.isArray(candidates) || candidates.length === 0) continue
        const candidate = candidates[0]
        const parts = candidate?.content?.parts
        if (!Array.isArray(parts)) continue

        for (const part of parts) {
          if (part.functionCall) {
            hadTools = true
            const fc = part.functionCall
            const id = fc.id ?? `call_${fc.name}_${Math.random().toString(16).slice(2, 10)}`
            const name = fc.name ?? ''
            // Gemini emits the reasoning signature as a sibling of functionCall on the part.
            // Stash it by call_id so the NEXT turn can replay the real signature (see
            // translateMessages) instead of the validator-bypass placeholder.
            if (typeof part.thoughtSignature === 'string' && part.thoughtSignature) {
              rememberThoughtSig(id, part.thoughtSignature)
            }
            emitter.openToolUse(id, name)
            if (fc.args !== undefined) {
              emitter.pushToolArgsDelta(JSON.stringify(fc.args))
            }
          } else if (part.thought) {
            const text = (typeof part.text === 'string' && part.text) || ''
            if (text) { emitter.pushThinking(text); thinkingBuf += text }
          } else if (typeof part.text === 'string') {
            emitter.pushTextAccumulated(part.text)
          }
        }

        if (candidate.finishReason) {
          lastFinishReason = candidate.finishReason
          emitter.closeBlock()
        }
      }

      if (hadTools) {
        emitter.setStopReason('tool_use')
      } else if (lastFinishReason === 'MAX_TOKENS') {
        emitter.setStopReason('max_tokens')
      } else if (!emitter.hasProducedContent()) {
        // The turn collapsed with no usable output. Most common cause:
        // MALFORMED_FUNCTION_CALL — the model tried to call a tool but botched the
        // JSON, so Gemini emitted neither a valid functionCall nor answer text. Mark
        // unusable so the adapter can retry; and degrade gracefully by surfacing the
        // accumulated reasoning as visible text so the harness never gets a silent empty
        // turn (which would otherwise look like a capability failure, not a transient one).
        emitter.markUnusable()
        const fallback =
          thinkingBuf.trim() ||
          `[gateway] upstream returned no usable content (finishReason=${lastFinishReason || 'none'}); retry the request.`
        emitter.pushText(fallback)
        emitter.setStopReason('end_turn')
      } else {
        emitter.setStopReason('end_turn')
      }

      emitter.finish()
    },

    async listModels(): Promise<ModelInfo[]> {
      const token = await getOrRefreshAccessToken()
      const proj = await getProject(token)
      const res = await fetch(`https://${CC_HOST}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify({ project: proj }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error(`fetchAvailableModels failed: ${res.status} ${text}`)
      }
      const data = (await res.json()) as any
      const models = data.models || {}
      // CloudCode 的模型表里混着非面向用户的内部条目: chat_<数字> 是会话槽位、
      // tab_* 是编辑器行内补全用的。它们没有 displayName，喂给客户端会被当成
      // 可选模型挑走(实测 free-code 会选中 chat_20706)。这里滤掉。
      const isInternal = (id: string, m: any): boolean =>
        /^(chat|tab)_/.test(id) || !m?.displayName
      return Object.keys(models)
        .filter(id => !isInternal(id, models[id]))
        .map(id => ({
        id: id,
        name: models[id].displayName || id,
        supportsImages: models[id].supportsImages,
        supportsThinking: models[id].supportsThinking,
        maxOutputTokens: models[id].maxOutputTokens,
      }))
    },

    async getQuota(): Promise<QuotaInfo> {
      const token = await getOrRefreshAccessToken()
      const proj = await getProject(token)
      return {
        planType: 'antigravity-cloudcompanion',
        tier: proj,
      }
    },
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function systemPromptToTexts(system: AnthropicMessagesRequest['system']): string[] {
  if (!system) return []
  if (typeof system === 'string') return [system]
  if (!Array.isArray(system)) return []
  return system
    .map(b => (b.type === 'text' ? b.text ?? '' : typeof b === 'string' ? b : ''))
    .filter(Boolean)
}

function collectToolNamesById(messages: AnthropicMessage[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content as AnthropicContentBlock[]) {
      if (block.type === 'tool_use' && block.id && block.name) map.set(block.id, block.name)
    }
  }
  return map
}

// Gemini ties multi-turn reasoning to a per-functionCall `thoughtSignature`: it MUST be
// replayed with that functionCall on later turns, or the model loses its reasoning thread
// across the tool loop → re-planning loops, MALFORMED_FUNCTION_CALL, and 400 INVALID_ARGUMENT.
// The signature cannot survive a codex/openai round-trip (no wire field carries it), so we
// cache it server-side keyed by call_id — which is stable end-to-end (gemini functionCall.id
// → codex call_id → replayed tool_use.id) — and re-attach it in translateMessages instead of
// the `skip_thought_signature_validator` bypass placeholder (which carries no reasoning and is
// what made the agent loop). Module-level so it persists across the per-request provider
// instances; bounded to cap memory on the long-lived daemon.
const THOUGHT_SIG_CACHE_MAX = 4096
const thoughtSigByCallId = new Map<string, string>()
function rememberThoughtSig(callId: string, signature: string): void {
  if (!callId || !signature) return
  if (thoughtSigByCallId.has(callId)) thoughtSigByCallId.delete(callId) // refresh LRU position
  thoughtSigByCallId.set(callId, signature)
  if (thoughtSigByCallId.size > THOUGHT_SIG_CACHE_MAX) {
    const oldest = thoughtSigByCallId.keys().next().value
    if (oldest !== undefined) thoughtSigByCallId.delete(oldest)
  }
}

function translateMessages(
  messages: AnthropicMessage[],
  toolNameByID: Map<string, string>,
): Array<Record<string, unknown>> {
  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = []

  for (const msg of messages) {
    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts: Array<Record<string, unknown>> = []

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as AnthropicContentBlock[]) {
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text })
        } else if (block.type === 'image' && block.source && (block.source as any).type === 'base64') {
          const src = block.source as any
          parts.push({ inlineData: { mimeType: src.media_type, data: src.data } })
        } else if (block.type === 'tool_use') {
          parts.push({
            functionCall: { id: block.id, name: block.name, args: block.input ?? {} },
            // Prefer the REAL signature gemini emitted for this call_id (cached on the prior
            // turn); fall back to the inline block field, then the bypass placeholder only when
            // we genuinely never saw a signature (e.g. a tool call that didn't originate here).
            thoughtSignature:
              (block as any).thoughtSignature ??
              thoughtSigByCallId.get(block.id ?? '') ??
              'skip_thought_signature_validator',
          })
        } else if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              id: block.tool_use_id,
              name: toolNameByID.get(block.tool_use_id ?? '') ?? block.name ?? 'tool',
              response: toolResultToResponse(block),
            },
          })
        }
      }
    }

    if (parts.length === 0) continue
    const last = contents[contents.length - 1]
    if (last && last.role === role) {
      last.parts.push(...parts)
    } else {
      contents.push({ role, parts })
    }
  }

  return contents as Array<Record<string, unknown>>
}

export function toolResultToResponse(block: AnthropicContentBlock): Record<string, unknown> {
  const isError = (block as any).is_error
  if (isError) {
    return {
      error: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
    }
  }
  if (Array.isArray(block.content)) {
    const mediaParts = (block.content as AnthropicContentBlock[]).filter(p => p.type === 'image')
    if (mediaParts.length > 0) {
      const images = mediaParts.map(p => {
        const src = p.source as any
        return {
          media_type: src.media_type ?? 'image/jpeg',
          data: src.data ?? '',
        }
      })
      const text = (block.content as AnthropicContentBlock[])
        .filter(p => p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text as string)
        .join('\n\n')
      
      return {
        media_type: images[0]!.media_type,
        data: images[0]!.data,
        text,
        images,
      }
    }
    const text = (block.content as AnthropicContentBlock[])
      .map(p => p.text ?? '')
      .filter(Boolean)
      .join('\n\n')
    return { result: text }
  }
  return { result: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) }
}
