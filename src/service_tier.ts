import type { ServiceTierIntent } from './types.js'

const PRIORITY_TIER = 'priority'
const ANTHROPIC_FAST_SPEED = 'fast'

/** Decode OpenAI's wire spelling without giving it a second IR representation. */
export function parseServiceTier(value: unknown): ServiceTierIntent | undefined {
  if (value === undefined || value === null) return undefined
  if (value === PRIORITY_TIER) return { tier: PRIORITY_TIER, source: 'client' }
  throw new Error(`Unsupported service tier '${String(value)}'; expected priority`)
}

/** Decode Anthropic's equivalent scheduling knob into the same canonical intent. */
export function parseAnthropicSpeed(value: unknown): ServiceTierIntent | undefined {
  if (value === undefined || value === null) return undefined
  if (value === ANTHROPIC_FAST_SPEED) return { tier: PRIORITY_TIER, source: 'client' }
  throw new Error(`Unsupported Anthropic speed '${String(value)}'; expected fast`)
}

export function toAnthropicSpeed(intent: ServiceTierIntent | undefined): 'fast' | undefined {
  return intent?.tier === PRIORITY_TIER ? ANTHROPIC_FAST_SPEED : undefined
}
