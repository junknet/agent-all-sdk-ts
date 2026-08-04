import type { AnthropicEventEmitter } from './emitter.js'

export type WireProviderName = 'antigravity' | 'openai-compat' | 'codex' | 'anthropic-passthrough' | 'windsurf'

export type ClientProtocol =
  | 'anthropic_messages'
  | 'openai_chat_completions'
  | 'openai_responses'

export interface ModelInfo {
  id: string
  name: string
  /** Optional upstream admission contract, when the provider catalog supplies it. */
  clientProtocol?: ClientProtocol
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

/**
 * 一处**网关自己知道、客户端不知道**的信息丢失。
 *
 * 出口之间能力不齐，翻译必然有损：codex Responses 收不了 max_tokens，Gemini 执行不了
 * builtin 工具，函数声明还有 128 条硬上限。这些丢弃本身没错，错的是**悄悄**丢 ——
 * 客户端设了上限却零作用、传了工具却不存在，两边对同一次请求的理解从此分叉，且没有
 * 任何地方能查。原先只有工具预算那一处有 droppedNamespaces 上报，其余全静默；IRLoss
 * 把那个一次性机制泛化成通用留痕，每一处丢弃都落盘成一条可查记录。
 *
 * 它只写日志，不改出站字节流 —— 有损是既成事实，记下来是为了可诊断，不是为了改行为。
 */
export interface IRLoss {
  /** ingress = 入站解码丢的；egress = 出站 buildRequest 丢的；lift = 上游响应回抬时丢的。 */
  readonly stage: 'ingress' | 'egress' | 'lift'
  /** 丢在哪个出口上；入站阶段还没选出口时为 null。 */
  readonly provider: string | null
  /** 丢的是哪个字段，用 IR 路径表示，如 '$.max_tokens'。 */
  readonly path: string
  readonly kind: 'dropped' | 'degraded' | 'substituted' | 'truncated'
  /** 为什么丢 —— 写清上游的拒收理由，诊断时不必再回来读代码。 */
  readonly detail: string
}

export interface WirePreparedRequest {
  url: string
  headers: Record<string, string>
  /** JSON 出口用 string；Connect/protobuf 等二进制出口必须原样交给 fetch。 */
  body: string | Uint8Array
  /**
   * 本次 egress 翻译丢掉的东西。调用方(createWireAdapter)持有 trace，负责逐条落盘 ——
   * provider 自己没有 trace，把 loss 带出去比在 provider 里硬凑一个日志上下文干净。
   */
  losses?: IRLoss[]
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
