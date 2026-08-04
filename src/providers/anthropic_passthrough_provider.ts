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
import { parseAnthropicThinking, toAnthropicThinking } from '../thinking.js'
import { parseAnthropicSpeed, parseServiceTier, toAnthropicSpeed } from '../service_tier.js'
import type { AnthropicEventEmitter } from '../emitter.js'
import type { TokenSource } from '../auth.js'
import { reconcileThinkingSampling } from '../anthropic_constraints.js'

export interface AnthropicPassthroughOpts {
  baseURL: string
  apiKey: string
  model: string
  source?: TokenSource
  /** 入站请求自带的 anthropic-beta（逗号分隔）。见 mergeBeta 的注释。 */
  inboundBeta?: string
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

// OAuth 模式下网关必须自己发 OAUTH_BETA（Bearer + claude-code 那几个 flag 是
// 订阅鉴权的一部分），但**不能因此丢掉客户端声明的 beta** —— 客户端会带只有它自己
// 知道要用的实验特性。曾经的症状：free-code 在 system 块上带
// cache_control:{type:'ephemeral',scope:…}，scope 属于它声明、而网关没转发的 beta，
// 上游 400 "cache_control.ephemeral.scope: Extra inputs are not permitted"，整轮死。
// 早先的权宜之计是把 scope 剥掉降级；现在改为合并两侧 beta，客户端的实验特性能真正
// 生效，也不会再被下一个新 beta 撞到。
// 兼容垫片，与 mergeBeta 是两层不同的问题：
//   mergeBeta 解决"客户端声明了 beta，但被网关的固定头覆盖掉"；
//   这里解决"客户端用了新字段却根本不声明 beta"。
// 实测 free-code 2.1.87 属于后者：走自定义 ANTHROPIC_BASE_URL 时它不发
// anthropic-beta 头，body 里却带 system[].cache_control.ephemeral.scope，
// 上游 400 "cache_control.ephemeral.scope: Extra inputs are not permitted"，整轮死。
// 剥掉 scope 是降级不是报错——缓存仍生效，只是回到默认作用域。
function stripUnsupportedCacheScope<T>(system: T): T {
  if (!Array.isArray(system)) return system
  return system.map(b => {
    const cc = (b as { cache_control?: Record<string, unknown> })?.cache_control
    if (!cc || !('scope' in cc)) return b
    const { scope: _drop, ...rest } = cc
    return { ...(b as object), cache_control: rest }
  }) as unknown as T
}

// 有的模型不接受**显式关闭**思考：claude-fable-5 收到 thinking:{type:'disabled'} 直接
// 400 "\"thinking.type.disabled\" is not supported for this model. Thinking defaults to
// adaptive mode when not specified"(实测 2026-08-03；同一时刻 claude-opus-5 /
// claude-sonnet-5 / claude-opus-4-8 都接受)。而网关把 reasoning_effort=none/off 一律
// 翻成 thinking:{type:'disabled'}，于是"在 fable 上关思考"这个动作必死。
// 上游明说了"不指定就是 adaptive"，所以降级办法是**整个删掉 thinking 字段**：达不到
// 客户端要的"完全不思考"，但请求能过——和同文件里 stripUnsupportedCacheScope 一个路子，
// 降级好过整轮 400。模型目录侧同步把 canDisableThinking 改成 false，别再对外撒谎。
const NO_EXPLICIT_THINKING_DISABLE = new Set(['claude-fable-5'])

function stripUnsupportedThinkingDisable<T extends { thinking?: { type?: string } }>(
  body: T,
  model: string,
): T {
  if (body.thinking?.type !== 'disabled') return body
  if (!NO_EXPLICIT_THINKING_DISABLE.has(model)) return body
  const { thinking: _drop, ...rest } = body
  return rest as T
}

function mergeBeta(inbound: string | undefined): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of `${OAUTH_BETA},${inbound ?? ''}`.split(',')) {
    const v = part.trim()
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out.join(',')
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
        'anthropic-beta': mergeBeta(opts.inboundBeta),
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
      const {
        reasoning,
        serviceTier: canonicalServiceTier,
        thinking: legacyThinking,
        service_tier: legacyServiceTier,
        speed: legacySpeed,
        ...requestWithoutGatewayFields
      } = req
      // Direct provider callers may still hand us an Anthropic wire object. The
      // ingress path always supplies `reasoning`; this fallback keeps the public
      // provider factory backwards compatible without leaking the legacy field.
      const thinking = toAnthropicThinking(reasoning ?? parseAnthropicThinking(legacyThinking))
      const serviceTier =
        canonicalServiceTier ?? parseAnthropicSpeed(legacySpeed) ?? parseServiceTier(legacyServiceTier)
      const speed = toAnthropicSpeed(serviceTier)
      const wireRequest: AnthropicMessagesRequest = {
        ...requestWithoutGatewayFields,
        ...(thinking ? { thinking } : {}),
        ...(speed ? { speed } : {}),
      }
      // Thinking 与采样参数的冲突多半是网关自己注入的，在发出去之前收掉。
      reconcileThinkingSampling(wireRequest)
      const targetModel = opts.model || req.model || ''
      const body = stripUnsupportedThinkingDisable({
        ...wireRequest,
        model: targetModel,
        // 本 provider 的 parseStream 是纯 SSE 转发(emitRawChunk)。入口若没显式要
        // stream，上游会回单个 JSON 对象，SSE 解析器一个事件都取不到 → 下游收到
        // 空流(只有 message_delta + message_stop，usage 0/0)。codex/antigravity
        // 两个 provider 都写死 stream:true，这里对齐。
        stream: true,
        ...(isOAuth
          ? { system: stripUnsupportedCacheScope(withClaudeCodeIdentity(req.system)) }
          : { system: stripUnsupportedCacheScope(req.system) }),
      }, targetModel)
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
      // 本 provider 是纯字节转发，没有事件 switch，因此没有"没匹配上就丢掉"的黑洞 ——
      // 每个上游事件都原样出站，unhandled 在这里无对象可记(详见 emitter.unhandled 的说明)。
      // 它唯一的静默失败是另一半：上游把连接掐了却没发 message_stop / error，
      // createWireAdapter 的兜底 finish() 会补一份 stop_reason:'end_turn' 的收尾，
      // 于是半截流看起来像一次正常结束。
      if (!emitter.hasUpstreamTerminal()) {
        emitter.error({
          type: 'api_error',
          message:
            '[gateway] anthropic-passthrough upstream stream ended without message_stop; ' +
            'the turn is truncated',
        })
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
