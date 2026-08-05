/**
 * Legacy bare-id DeepSeek routing.
 *
 * The public catalog no longer contains any of these ids: every published
 * DeepSeek model is channel-qualified (`official-deepseek-v4-pro`,
 * `bailian-deepseek-v4-flash-0731`) and routed by `model_registry.ts`.
 *
 * What survives here is the compatibility path for clients that were never
 * migrated and still send a bare `deepseek-*`. A bare id cannot express a
 * platform, so it resolves to the official API — the historical behaviour.
 * Anything wanting Bailian must name the channel.
 *
 * Retire this file once no client sends bare ids: the gateway logs the
 * requested model on every inbound request (the structured request log), so
 * "nobody sends bare deepseek ids anymore" is checkable, not a guess.
 */

export type DeepSeekPlatform = 'official' | 'bailian'

export interface DeepSeekRoute {
  readonly platform: DeepSeekPlatform
  /** Canonical lower-case model id sent to the upstream API. */
  readonly model: string
}

/**
 * Bare aliases accepted from un-migrated clients, all on the official API.
 *
 * The official API calls the current Flash weights `deepseek-v4-flash`;
 * `DeepSeek-V4-Flash-0731` is the docs' version label and is NOT an accepted
 * official model id — it exists only on Bailian, hence only as a channel id.
 */
const LEGACY_BARE_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
}

/**
 * Resolve a bare DeepSeek id to the official platform.
 *
 * Returns null for anything that is not a DeepSeek id at all, so unrelated
 * models fall through to the other provider branches untouched. An
 * unsupported DeepSeek id throws instead of silently falling through to a
 * different credential-backed provider.
 */
export function resolveDeepSeekRoute(modelId: string): DeepSeekRoute | null {
  const normalized = modelId.trim().toLowerCase()
  const model = LEGACY_BARE_ALIASES[normalized]
  if (model) return { platform: 'official', model }

  if (!/^deepseek-/i.test(normalized)) return null
  const supported = Object.keys(LEGACY_BARE_ALIASES).join(', ')
  const hint = normalized.endsWith('-0731')
    ? " The dated Bailian weights are published as 'bailian-deepseek-v4-flash-0731'."
    : ''
  throw new Error(
    `Unsupported bare DeepSeek model '${modelId}'. Supported bare ids: ${supported}.` +
      `${hint} Channel-qualified ids (official-*, bailian-*) are routed by the model registry.`,
  )
}
