import type { AnthropicMessagesRequest, ReasoningIntent, ThinkingEffort } from './types.js'

const EFFORT_BUDGET: Readonly<Record<string, number>> = Object.freeze({
  minimal: 512,
  low: 1_024,
  medium: 4_096,
  high: 10_000,
  xhigh: 20_000,
  max: 32_000,
})

export function parseReasoningEffort(
  raw: unknown,
  source: ReasoningIntent['source'] = 'client',
): ReasoningIntent | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const effort = typeof raw === 'string' ? raw : (raw as any)?.effort
  if (typeof effort !== 'string' || effort.trim() === '') {
    throw new Error('Invalid reasoning effort: expected a string or { effort: string }')
  }
  const normalized = effort.toLowerCase()
  if (['none', 'off', 'disabled'].includes(normalized)) return { mode: 'disabled', source }
  if (normalized === 'auto') return { mode: 'auto', source }
  if (EFFORT_BUDGET[normalized] === undefined) {
    throw new Error(
      `Unsupported reasoning effort '${effort}'; expected none, minimal, low, medium, high, xhigh, max, or auto`,
    )
  }
  return { mode: 'effort', effort: normalized as ThinkingEffort, source }
}

/** Parse Anthropic's native numeric expression without first inventing a tier. */
export function parseAnthropicThinking(raw: unknown): ReasoningIntent | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const thinking = raw as { type?: unknown; budget_tokens?: unknown }
  if (thinking.type === 'disabled') return { mode: 'disabled', source: 'client' }
  if (thinking.type !== 'enabled') return undefined
  if (typeof thinking.budget_tokens !== 'number' || !Number.isFinite(thinking.budget_tokens) || thinking.budget_tokens <= 0) {
    throw new Error('Invalid Anthropic thinking budget: expected a positive finite number')
  }
  return { mode: 'budget', budgetTokens: thinking.budget_tokens, source: 'client' }
}

/** Only the Anthropic wire owns this tier-to-budget mapping. */
export function toAnthropicThinking(intent: ReasoningIntent | undefined): AnthropicMessagesRequest['thinking'] | undefined {
  if (!intent) return undefined
  if (intent.mode === 'disabled') return { type: 'disabled' }
  if (intent.mode === 'auto') return undefined
  if (intent.mode === 'budget') return { type: 'enabled', budget_tokens: intent.budgetTokens }
  return { type: 'enabled', budget_tokens: EFFORT_BUDGET[intent.effort] }
}

/** Codex Responses accepts only these three tiers; numeric budgets are an unavoidable egress downgrade. */
export function toCodexEffort(intent: ReasoningIntent | undefined): 'low' | 'medium' | 'high' | undefined {
  if (!intent || intent.mode === 'disabled' || intent.mode === 'auto') return undefined
  if (intent.mode === 'effort') {
    if (intent.effort === 'minimal' || intent.effort === 'low') return 'low'
    if (intent.effort === 'medium') return 'medium'
    return 'high'
  }
  return intent.budgetTokens <= 1_024 ? 'low' : intent.budgetTokens <= 4_096 ? 'medium' : 'high'
}

/** Gemini's wire uses a budget; its model gear may override this at egress. */
export function toGeminiBudget(intent: ReasoningIntent | undefined): number | undefined {
  if (!intent || intent.mode === 'disabled' || intent.mode === 'auto') return undefined
  return intent.mode === 'budget' ? intent.budgetTokens : EFFORT_BUDGET[intent.effort]
}
