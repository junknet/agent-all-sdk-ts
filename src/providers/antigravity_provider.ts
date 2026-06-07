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
const TOKEN_PATH = path.join(os.homedir(), '.gemini', 'oauth_creds.json')
const USER_AGENT = 'antigravity/fantasy/1.0.0 linux/amd64'
const ENDPOINT =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse'

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

let cachedProject: string | null = null

export async function getProject(accessToken: string): Promise<string> {
  if (cachedProject) return cachedProject
  const res = await fetch(
    'https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
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
  if (!data.cloudaicompanionProject) {
    throw new Error(`loadCodeAssist returned no cloudaicompanionProject`)
  }
  cachedProject = data.cloudaicompanionProject
  return cachedProject!
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
  'gemini-3.5-flash-high': 'gemini-3-flash-agent',
  'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-extra-low',
  'gemini-3.5-flash': 'gemini-3.5-flash-low',
  // The agent endpoint only accepts the `-agent` backend ids; the friendly Pro id
  // `gemini-3.1-pro-high` 400s (INVALID_ARGUMENT). Route it to the callable Pro agent —
  // same enum tier (M16, budget 10001) — so codex-g-max works. Mirrors flash-high→flash-agent.
  'gemini-3.1-pro-high': 'gemini-pro-agent',
})

export const ANTIGRAVITY_DEFAULT_MODEL = 'gemini-3-flash-agent'

export function resolveAntigravityModel(input: string | undefined): string {
  const name = (input ?? '').trim() || ANTIGRAVITY_DEFAULT_MODEL
  return ANTIGRAVITY_MODEL_ALIAS[name] ?? name
}

export interface AntigravityModelMeta {
  enum: string
  budget: number
}

export const ANTIGRAVITY_MODEL_META: Readonly<Record<string, AntigravityModelMeta>> = Object.freeze({
  'gemini-3-flash': { enum: 'MODEL_PLACEHOLDER_M18', budget: -1 },
  'gemini-3-flash-agent': { enum: 'MODEL_PLACEHOLDER_M132', budget: 10000 },
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
      if (req.max_tokens) genCfg.maxOutputTokens = req.max_tokens
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
      const res = await fetch('https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
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
      return Object.keys(models).map(id => ({
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
            thoughtSignature: (block as any).thoughtSignature ?? 'skip_thought_signature_validator',
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
