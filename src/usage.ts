/**
 * Token 用量的单一真源与跨协议换算。
 *
 * 为什么要单独一层：下游 harness 的「上下文用到 70% 就压缩」这条硬需求，唯一输入就是
 * 响应里回的 token 用量。网关内部其实一直算得出来(四个 provider 都会往
 * AnthropicEventEmitter 里 setUsage，`phase:"done"` 日志每条都有)，但只有 Anthropic 出口
 * 把它带回给客户端 —— OpenAI 的两个出口一个都没转，于是走 /v1/chat/completions 的
 * harness(jcode)侧 token 统计恒为 0，压缩阈值等于没实现。
 *
 * ── 口径统一：IR 内部一律用 Anthropic 语义 ────────────────────────────
 * 这里有个极易踩的坑：**两家的 input token 是否含缓存命中，定义相反**。
 *   Anthropic: `input_tokens` **不含** cache_read_input_tokens / cache_creation_input_tokens
 *   OpenAI/codex: `input_tokens` **含** input_tokens_details.cached_tokens
 *   DeepSeek: `prompt_tokens` = prompt_cache_hit_tokens + prompt_cache_miss_tokens(含)
 * 所以各 provider 在 setUsage 时必须先把「含缓存」的口径**减出**缓存部分，转成 Anthropic
 * 语义存进 IR；出口再按目标协议加回去。不统一的话，prompt_tokens 要么漏算几万缓存
 * token(压缩永远不触发)，要么双倍计数。
 */

/** IR 内的规范用量，Anthropic 语义(inputTokens 不含缓存部分)。 */
export interface CanonicalUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export function emptyUsage(): CanonicalUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
}

/**
 * 上下文实际占用 = 输入 + 缓存读 + 缓存写。这就是 harness 该拿来和 context_length
 * 比的那个数：缓存命中的 token 一样占上下文窗口，只是不重新计费。
 * 实测(PROTOCOL_REFERENCE §10)真实一轮是 input_tokens 少量 + cache_read 28258 —— 只报
 * input_tokens 的话 harness 会认为上下文几乎是空的，70% 阈值永远不触发。
 */
export function promptTokens(usage: CanonicalUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
}

/** 缓存命中数；0 表示上游没报或不支持缓存 —— 不硬造。 */
export function cachedTokens(usage: CanonicalUsage): number {
  return usage.cacheReadTokens
}

/**
 * 认得 Anthropic SSE 里 usage 字段名的**唯一一处**。message_start 把 usage 挂在
 * message 下，message_delta 挂在顶层，两处都要认。
 * emitter(裸转发 provider)和两个 OpenAI 出口共用它，避免字段名散落多处各认一半。
 */
export function pickAnthropicUsage(payload: unknown): Partial<CanonicalUsage> {
  if (!payload || typeof payload !== 'object') return {}
  const p = payload as any
  const u = p.message?.usage ?? p.usage
  if (!u || typeof u !== 'object') return {}
  const out: Partial<CanonicalUsage> = {}
  if (typeof u.input_tokens === 'number') out.inputTokens = u.input_tokens
  if (typeof u.output_tokens === 'number') out.outputTokens = u.output_tokens
  if (typeof u.cache_read_input_tokens === 'number') out.cacheReadTokens = u.cache_read_input_tokens
  if (typeof u.cache_creation_input_tokens === 'number') {
    out.cacheCreationTokens = u.cache_creation_input_tokens
  }
  return out
}

/**
 * 顺着 Anthropic SSE 流收集用量。用「有值才覆盖」而不是累加：message_start 与
 * message_delta 报的是同一轮的快照(后者更全)，累加会翻倍。
 */
export interface UsageCollector {
  observe(payload: unknown): void
  snapshot(): CanonicalUsage
}

export function createUsageCollector(): UsageCollector {
  const acc = emptyUsage()
  return {
    observe(payload: unknown): void {
      const picked = pickAnthropicUsage(payload)
      if (picked.inputTokens !== undefined) acc.inputTokens = picked.inputTokens
      if (picked.outputTokens !== undefined) acc.outputTokens = picked.outputTokens
      if (picked.cacheReadTokens !== undefined) acc.cacheReadTokens = picked.cacheReadTokens
      if (picked.cacheCreationTokens !== undefined) {
        acc.cacheCreationTokens = picked.cacheCreationTokens
      }
    },
    snapshot(): CanonicalUsage {
      return { ...acc }
    },
  }
}

/** OpenAI Chat Completions 的 usage 形状。 */
export interface OpenAIChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_tokens_details?: { cached_tokens: number }
}

export function toOpenAIChatUsage(usage: CanonicalUsage): OpenAIChatUsage {
  const prompt = promptTokens(usage)
  const cached = cachedTokens(usage)
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    // 上游没报缓存就整个字段不出现，别用 0 冒充「确实没命中」。
    ...(cached > 0 ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
  }
}

/** OpenAI Responses API 的 usage 形状 —— 与 Chat 不同，别套错。 */
export interface OpenAIResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: { cached_tokens: number }
}

export function toResponsesUsage(usage: CanonicalUsage): OpenAIResponsesUsage {
  const input = promptTokens(usage)
  const cached = cachedTokens(usage)
  return {
    input_tokens: input,
    output_tokens: usage.outputTokens,
    total_tokens: input + usage.outputTokens,
    ...(cached > 0 ? { input_tokens_details: { cached_tokens: cached } } : {}),
  }
}

/**
 * 把「input 含缓存」的 OpenAI 系口径拆成 Anthropic 语义。
 * 传入的 totalInput 是含缓存的总输入，cached 是其中的缓存命中部分。
 */
export function splitCachedFromTotalInput(
  totalInput: number | undefined,
  cached: number | undefined,
): { input?: number; cacheRead?: number } {
  if (typeof totalInput !== 'number') {
    return typeof cached === 'number' ? { cacheRead: cached } : {}
  }
  if (typeof cached !== 'number' || cached <= 0) return { input: totalInput }
  // 上游偶发把 cached 报得比总输入还大时不要算出负数，宁可当作全部命中。
  return { input: Math.max(0, totalInput - cached), cacheRead: cached }
}
