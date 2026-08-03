import type { AnthropicEventEmitter } from './emitter.js'

export type WireProviderName = 'antigravity' | 'openai-compat' | 'codex' | 'anthropic-passthrough'

export interface ModelInfo {
  id: string
  name: string
  supportsImages?: boolean
  supportsTools?: boolean
  supportsThinking?: boolean
  thinkingEfforts?: ThinkingEffort[]
  defaultThinkingEffort?: ThinkingEffort
  canDisableThinking?: boolean
  contextWindow?: number
  maxOutputTokens?: number
}

export type ThinkingEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Provider-neutral reasoning intent.  This is deliberately not an Anthropic
 * `thinking` object: some callers express a semantic tier while Anthropic and
 * Gemini express a numeric budget.  Keeping the original representation makes
 * conversion an egress concern instead of a lossy ingress side effect.
 */
export type ReasoningIntent =
  | { readonly mode: 'disabled'; readonly source: 'client' | 'gateway-default' }
  | { readonly mode: 'auto'; readonly source: 'client' | 'gateway-default' }
  | {
      readonly mode: 'effort'
      readonly effort: ThinkingEffort
      readonly source: 'client' | 'gateway-default'
    }

  | {
      readonly mode: 'budget'
      readonly budgetTokens: number
      readonly source: 'client' | 'gateway-default'
    }

/**
 * Provider-neutral request scheduling intent.  This is deliberately separate
 * from `reasoning`: "fast" changes admission priority, not model deliberation.
 */
export interface ServiceTierIntent {
  readonly tier: 'priority'
  readonly source: 'client'
}

export interface QuotaInfo {
  tier?: string
  planType?: string
  limitRemaining?: number
  [key: string]: unknown
}

// ── Anthropic 请求侧 ─────────────────────────────────────────

export interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | AnthropicContentBlock[]
  source?: { type: 'base64'; media_type: string; data: string }
  thinking?: string
  signature?: string
  [key: string]: unknown
}

export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'system'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: Record<string, unknown>
}

export interface AnthropicMessagesRequest {
  model?: string
  messages: AnthropicMessage[]
  system?: string | AnthropicContentBlock[]
  tools?: AnthropicTool[]
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string }
  max_tokens?: number
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  /** Canonical, provider-neutral reasoning intent used after ingress decoding. */
  reasoning?: ReasoningIntent
  /** Canonical, provider-neutral scheduling intent used after ingress decoding. */
  serviceTier?: ServiceTierIntent
  /** Anthropic wire input only; ingress normalizes it into `reasoning`. */
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number }
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface WirePreparedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

export interface WireProvider {
  readonly name: WireProviderName
  prepare?(): Promise<void>
  buildRequest(req: AnthropicMessagesRequest): Promise<WirePreparedRequest>
  parseStream(response: Response, emitter: AnthropicEventEmitter): Promise<void>
  listModels?(): Promise<ModelInfo[]>
  getQuota?(): Promise<QuotaInfo>
}

export interface IngressAdapter {
  readonly protocol: 'messages' | 'chat' | 'responses'
  decodeRequest(rawBody: any): AnthropicMessagesRequest
  encodeResponse(
    upstreamResponse: Response,
    originalRequest: any,
    trace: string,
    context?: any
  ): Response | Promise<Response>
}
