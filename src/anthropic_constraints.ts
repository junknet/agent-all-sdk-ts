/**
 * Anthropic Messages API 的**结构性约束**归一层。
 *
 * 三个入口协议(Anthropic /v1/messages、OpenAI /v1/chat/completions、OpenAI
 * /v1/responses)形状各不相同，但都要落到同一个 Anthropic-canonical IR 再发给上游。
 * 上游对形状的挑剔程度不是猜的，下面每条都是 2026-08-03 对 api.anthropic.com
 * (OAuth ?beta=true 路径, claude-fable-5/opus-5)实打实探出来的：
 *
 *   强制(400)                                     | 宽容(200)
 *   ---------------------------------------------|---------------------------------
 *   user 消息 content 为空串                       | 连续同角色消息(会被合并)
 *   text 块 text 为空串                            | 首条消息是 assistant
 *   tool_result 找不到对应 tool_use                | content 为空数组
 *   tool_result 不在 tool_use 那条的**紧下一条**    | assistant content 为空串/空数组
 *   tool_result 不在该 user 消息的**最前面**        | tool_result.content 为空串
 *   缺 max_tokens                                 | 悬空 tool_use(无结果)*
 *   thinking 开启时 temperature ≠ 1               | max_tokens < thinking.budget_tokens
 *   thinking 开启时 top_p < 0.95                   |   (思考被静默忽略，不报错)
 *   tools[].input_schema 缺失/非对象               |
 *   tools 名字重复                                 |
 *   messages 为空数组                              |
 *   assistant content 为 null                      |
 *
 *   * 悬空 tool_use 在 api.anthropic.com 上宽容，但 DeepSeek 的 Anthropic 兼容端点
 *     强制("messages.6:`tool_use` ids were found without `tool_result` blocks
 *     immediately after"，实测 2026-08-02 jcode + official/deepseek-v4-flash)，
 *     所以仍然要补占位。
 */

import type { AnthropicMessagesRequest } from './types.js'

// 客户端历史里真缺结果时补的占位内容。措辞要让模型知道"这次结果不可信"，而不是
// 假装工具返回了空 —— 后者会让 agent 以为命令执行成功且无输出。
const MISSING_RESULT_PLACEHOLDER =
  '[gateway: tool result missing from client history — client-side bug, treat result as unknown]'

function toBlockArray(content: unknown): any[] {
  if (Array.isArray(content)) return content
  if (typeof content === 'string' && content !== '') return [{ type: 'text', text: content }]
  return []
}

/**
 * 把任意来源的消息序列归一成 Anthropic 认的工具回合形状：
 * **每个 tool_use.id 恰好一个 tool_result，且位于紧随该 assistant 消息之后那条 user
 * 消息的最前面**。
 *
 * 之所以是"先全摘下来再重排"而不是"就地打补丁"：三个入口都会以各自的方式破坏这个
 * 不变量，就地打补丁要按破坏方式一种一种堵，而且各步骤之间有顺序陷阱。实测踩过的坑：
 *  1. OpenAI 侧每个工具结果是独立的 role:'tool' 消息 → 一次并行工具调用转成连续多条
 *     user 消息；不合并就会被判成"漏了结果"而补占位，再和后一条里的真结果撞成
 *     400 "each tool_use must have a single result. Found multiple `tool_result`
 *     blocks with id: toolu_…"(实测 2026-08-02 jcode + claude-opus-5/claude-sonnet-5)。
 *  2. 占位块以前是 push 到下一条 user 消息**末尾**。Claude Code 形态的 user 回合是
 *     [tool_result, …, text(system-reminder)]，push 到末尾就成了 [tr, text, tr]，
 *     上游 400 "`tool_use` ids were found without `tool_result` blocks immediately
 *     after"(实测：[text, tool_result] 顺序必死，[tool_result, text] 才过)。
 *  3. 历史被客户端截断后会留下孤儿 tool_result(前面根本没有对应 tool_use)，上游 400
 *     "unexpected `tool_use_id` found in `tool_result` blocks"(实测 2026-08-02
 *     jcode + official/deepseek-v4-flash)。孤儿只能丢，留着必死。
 */
export function normalizeToolTurns(messages: any[]): void {
  if (!Array.isArray(messages)) return

  // 1. 把所有 tool_result 从原位摘走，按 tool_use_id 建索引(同 id 保留最先出现的
  //    那份 —— 重播历史里靠前的通常才是真结果)。非 tool_result 的块留在原地。
  const resultById = new Map<string, any>()
  for (const msg of messages) {
    if (msg?.role !== 'user' || !Array.isArray(msg.content)) continue
    const kept: any[] = []
    for (const block of msg.content) {
      if (block?.type !== 'tool_result' || typeof block?.tool_use_id !== 'string') {
        kept.push(block)
        continue
      }
      if (!resultById.has(block.tool_use_id)) resultById.set(block.tool_use_id, block)
    }
    msg.content = kept
  }

  // 2. 逐个 assistant 回合重建它后面那条 user 消息：本回合全部 tool_use 的结果按
  //    tool_use 出现顺序排在最前，其余原有内容顺延。正序遍历，插入的新消息落在 i+1，
  //    下一轮扫到它时 role 是 user 会被跳过，下标不需要修正。
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue
    const ids: string[] = [
      ...new Set<string>(
        msg.content
          .filter((b: any) => b?.type === 'tool_use' && typeof b?.id === 'string')
          .map((b: any) => b.id as string),
      ),
    ]
    if (ids.length === 0) continue

    const blocks = ids.map(
      id =>
        resultById.get(id) ?? {
          type: 'tool_result',
          tool_use_id: id,
          content: MISSING_RESULT_PLACEHOLDER,
        },
    )
    for (const id of ids) resultById.delete(id)

    const next = messages[i + 1]
    if (next?.role === 'user') {
      next.content = [...blocks, ...toBlockArray(next.content)]
    } else {
      messages.splice(i + 1, 0, { role: 'user', content: blocks })
    }
  }

  // 3. resultById 里剩下的都是孤儿(没有任何 tool_use 认领)。它们已经在第 1 步被摘走，
  //    这里不做任何事就等于丢弃 —— 这正是上游要求的。

  // 4. 清掉空消息：user 消息 content 为空串必 400；空数组虽然上游宽容，但它已经不携带
  //    任何信息，留着只会让后续 provider 的形状判断更难。
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content
    if (content === '' || content === null || (Array.isArray(content) && content.length === 0)) {
      messages.splice(i, 1)
    }
  }
}

/**
 * max_tokens 在 Anthropic Messages 里是必填，在 OpenAI Chat / Responses 里都可省略 ——
 * 省略时上游直接 400 "max_tokens: Field required"。两个 OpenAI 入口共用这个兜底值。
 * 可用 AGENT_GATEWAY_DEFAULT_MAX_TOKENS 调整。
 */
export function resolveDefaultMaxTokens(): number {
  const envDefault = Number(process.env.AGENT_GATEWAY_DEFAULT_MAX_TOKENS)
  return Number.isFinite(envDefault) && envDefault > 0 ? envDefault : 65536
}

/**
 * thinking 开启时 Anthropic 只接受 temperature=1 / top_p≥0.95(或都不给)，否则 400：
 *   "`temperature` may only be set to 1 when thinking is enabled"
 *   "`top_p` must be greater than or equal to 0.95 or unset when thinking is enabled"
 * 关键在于：**这个冲突多半是网关自己造的** —— AGENT_GATEWAY_DEFAULT_EFFORT 会给任何没
 * 声明 thinking 的请求注入思考预算，而客户端的采样参数是原样透传的。客户端只是发了一个
 * 它认为合法的 temperature=0，却被网关注入的 thinking 撞成 400。谁造的冲突谁负责收，
 * 所以这里丢采样参数而不是丢 thinking(思考档位是用户显式调的，采样参数多半是客户端默认值)。
 */
/**
 * Anthropic's floor for an enabled thinking budget.
 *
 * The gateway's own effort→budget table maps `minimal` to 512, which is below
 * this floor, so every `minimal` request to api.anthropic.com came back with
 * `thinking.enabled.budget_tokens: Input should be greater than or equal to
 * 1024` (verified across opus-5 / sonnet-5 / fable-5 / opus-4-8). The tier is
 * real and worth keeping — cc-relay accepts it, because it encodes the tier in
 * the model name instead of a budget — so the fix is to clamp at the outbox
 * that has the floor, not to stop advertising the tier.
 */
const ANTHROPIC_MIN_THINKING_BUDGET = 1024

/** Room left for visible text after raising max_tokens above the budget. */
const THINKING_TEXT_HEADROOM = 1024

export function reconcileThinkingSampling(req: AnthropicMessagesRequest): void {
  if (req?.thinking?.type !== 'enabled') return
  if (
    typeof req.thinking.budget_tokens === 'number' &&
    req.thinking.budget_tokens < ANTHROPIC_MIN_THINKING_BUDGET
  ) {
    req.thinking.budget_tokens = ANTHROPIC_MIN_THINKING_BUDGET
  }
  // max_tokens covers thinking too, and Anthropic rejects a budget that meets
  // or exceeds it. Raising the ceiling is the only non-destructive fix: lowering
  // the budget back would silently undo the tier the caller asked for.
  const budget = req.thinking.budget_tokens
  if (typeof budget === 'number' && typeof req.max_tokens === 'number' && req.max_tokens <= budget) {
    req.max_tokens = budget + THINKING_TEXT_HEADROOM
  }
  if (typeof req.temperature === 'number' && req.temperature !== 1) delete req.temperature
  if (typeof req.top_p === 'number' && req.top_p < 0.95) delete req.top_p
}
