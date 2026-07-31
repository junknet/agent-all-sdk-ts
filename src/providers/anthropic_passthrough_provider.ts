/**
 * Anthropic passthrough provider
 */

import type {
  AnthropicMessagesRequest,
  WireProvider,
  WirePreparedRequest,
  ModelInfo,
  QuotaInfo,
} from '../types.js'
import type { AnthropicEventEmitter } from '../emitter.js'
import type { TokenSource } from '../auth.js'

export interface AnthropicPassthroughOpts {
  baseURL: string
  apiKey: string
  model: string
  source?: TokenSource
}

// OAuth (Claude Max/Pro) and API-key are two distinct auth modes on the Anthropic
// wire: OAuth tokens (sk-ant-oat01-…) MUST go as `Authorization: Bearer` with the
// claude-code oauth beta flags and `?beta=true`; sending them as x-api-key 401s.
// API keys go as `x-api-key`. (PROTOCOL_REFERENCE §1.2)
const OAUTH_BETA =
  'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,fine-grained-tool-streaming-2025-05-14'

// OAuth(Pro/Max) 契约的第三个要件，除 Bearer 头和 ?beta=true 之外：system 的第一块
// 必须是 Claude Code 身份串。不带它上游回的是 429 + {"type":"rate_limit_error",
// "message":"Error"} —— 一个伪装成限流的拒绝，配额其实没动。实测(2026-07-30):
// 同一 token、同一 model，仅加这一块就从 429 变 200。api-key 模式不需要。
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."

// 客户端(free-code 2.1.87)会在 system 块上带 cache_control:{type:'ephemeral',scope:…}。
// scope 属于一个本网关没有声明的 beta，而网关把 anthropic-beta 头整个换成了自己那串
// OAUTH_BETA，客户端声明的 beta 到不了上游 → 400
// "system.N.cache_control.ephemeral.scope: Extra inputs are not permitted"，整轮请求死。
// 这里剥掉 scope：缓存本身仍生效，只是回到默认作用域，降级而非报错。
// 根治要把入站 anthropic-beta 合并进 OAUTH_BETA，那需要把 header 透到 WireProvider，
// 属于契约变更，先不做。
function stripUnsupportedCacheScope<T>(system: T): T {
  if (!Array.isArray(system)) return system
  return system.map(b => {
    const cc = (b as { cache_control?: Record<string, unknown> })?.cache_control
    if (!cc || !('scope' in cc)) return b
    const { scope: _drop, ...rest } = cc
    return { ...(b as object), cache_control: rest }
  }) as unknown as T
}

function withClaudeCodeIdentity(
  system: AnthropicMessagesRequest['system'],
): AnthropicMessagesRequest['system'] {
  const block = { type: 'text' as const, text: CLAUDE_CODE_IDENTITY }
  if (system === undefined || system === null) return [block]
  if (typeof system === 'string') {
    return system.startsWith(CLAUDE_CODE_IDENTITY) ? system : [block, { type: 'text', text: system }]
  }
  if (!Array.isArray(system)) return [block]
  // 已经带了就不重复插入（调用方是 Claude Code / free-code 时会自带）
  const first = system[0] as { text?: string } | undefined
  if (first?.text?.startsWith(CLAUDE_CODE_IDENTITY)) return system
  return [block, ...system]
}

export function createAnthropicPassthroughProvider(
  opts: AnthropicPassthroughOpts,
): WireProvider {
  const isOAuth = !!opts.source

  const resolveKey = async (): Promise<string> => (opts.source ? opts.source.token() : opts.apiKey)

  const authHeaders = (key: string): Record<string, string> => {
    if (isOAuth) {
      return {
        Authorization: `Bearer ${key}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA,
        'x-app': 'cli',
      }
    }
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  }

  const messagesUrl = (): string => {
    const baseURL = opts.baseURL.replace(/\/$/, '')
    const path = baseURL.endsWith('/v1') ? `${baseURL}/messages` : `${baseURL}/v1/messages`
    return isOAuth ? `${path}?beta=true` : path
  }

  return {
    name: 'anthropic-passthrough',

    async buildRequest(req: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const body = {
        ...req,
        model: opts.model || req.model,
        // 本 provider 的 parseStream 是纯 SSE 转发(emitRawChunk)。入口若没显式要
        // stream，上游会回单个 JSON 对象，SSE 解析器一个事件都取不到 → 下游收到
        // 空流(只有 message_delta + message_stop，usage 0/0)。codex/antigravity
        // 两个 provider 都写死 stream:true，这里对齐。
        stream: true,
        ...(isOAuth
          ? { system: stripUnsupportedCacheScope(withClaudeCodeIdentity(req.system)) }
          : { system: stripUnsupportedCacheScope(req.system) }),
      }
      const key = await resolveKey()
      return {
        url: messagesUrl(),
        headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
        body: JSON.stringify(body),
      }
    },

    async parseStream(response: Response, emitter: AnthropicEventEmitter): Promise<void> {
      const reader = response.body?.getReader()
      if (!reader) {
        emitter.start({ model: opts.model })
        emitter.error(new Error('anthropic-passthrough: empty response body'))
        return
      }
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            emitter.emitRawChunk(decoder.decode(value, { stream: true }))
          }
        }
      } finally {
        try {
          reader.releaseLock()
        } catch {}
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      const baseURL = opts.baseURL.replace(/\/$/, '')
      const url = baseURL.endsWith('/v1')
        ? `${baseURL}/models`
        : `${baseURL}/v1/models`

      const key = await resolveKey()
      const res = await fetch(url, {
        method: 'GET',
        headers: authHeaders(key),
      })
      if (!res.ok) {
        // Fallback to basic list
        return [
          { id: 'claude-opus-5', name: 'Claude Opus 5' },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        ]
      }
      const data = (await res.json()) as any
      const list = data.data || []
      return list.map((m: any) => ({
        id: m.id,
        name: m.display_name || m.id,
      }))
    },

    async getQuota(): Promise<QuotaInfo> {
      if (opts.source && opts.source.getQuota) {
        return opts.source.getQuota()
      }
      return {
        planType: 'anthropic-free',
      }
    },
  }
}
