/** DeepSeek model routing for the official and Bailian platforms. */

export type DeepSeekPlatform = 'official' | 'bailian'

export interface DeepSeekRoute {
  readonly platform: DeepSeekPlatform
  /** Canonical lower-case model id sent to the upstream API. */
  readonly model: string
}

export interface DeepSeekModelDescriptor extends DeepSeekRoute {
  readonly id: string
  readonly aliases: readonly string[]
  readonly credentialEnvironmentVariable: 'DEEPSEEK_API_KEY' | 'DASHSCOPE_API_KEY'
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly supportsImages: boolean
  readonly supportsTools: boolean
  readonly supportsThinking: boolean
  readonly thinkingEfforts: readonly ('high' | 'max')[]
  readonly canDisableThinking: boolean
}

/**
 * Single authored DeepSeek catalog. Public discovery, aliases and upstream
 * routing are all derived from these descriptors so they cannot drift.
 */
export const DEEPSEEK_MODEL_DESCRIPTORS: readonly DeepSeekModelDescriptor[] = [
  {
    id: 'official/deepseek-v4-flash',
    aliases: ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
    platform: 'official',
    model: 'deepseek-v4-flash',
    credentialEnvironmentVariable: 'DEEPSEEK_API_KEY',
    contextWindow: 1_048_576,
    maxOutputTokens: 384_000,
    supportsImages: false,
    supportsTools: true,
    supportsThinking: true,
    thinkingEfforts: ['high', 'max'],
    canDisableThinking: true,
  },
  {
    id: 'official/deepseek-v4-pro',
    aliases: ['deepseek-v4-pro'],
    platform: 'official',
    model: 'deepseek-v4-pro',
    credentialEnvironmentVariable: 'DEEPSEEK_API_KEY',
    contextWindow: 1_048_576,
    maxOutputTokens: 384_000,
    supportsImages: false,
    supportsTools: true,
    supportsThinking: true,
    thinkingEfforts: ['high', 'max'],
    canDisableThinking: true,
  },
  {
    id: 'bailian/deepseek-v4-flash-0731',
    aliases: ['bailian/deepseek-v4-flash'],
    platform: 'bailian',
    model: 'deepseek-v4-flash-0731',
    credentialEnvironmentVariable: 'DASHSCOPE_API_KEY',
    contextWindow: 1_048_576,
    maxOutputTokens: 384_000,
    supportsImages: false,
    supportsTools: true,
    supportsThinking: true,
    thinkingEfforts: ['high', 'max'],
    canDisableThinking: false,
  },
] as const

/** True for a model id that explicitly selects one of the two platforms. */
export function hasDeepSeekPlatformPrefix(modelId: string): boolean {
  return /^(?:official|bailian)\/deepseek-/i.test(modelId.trim())
}

/**
 * Resolve a DeepSeek model id. A bare supported id uses the official API.
 *
 * Unsupported V4 ids fail locally instead of falling through to another
 * credential-backed provider. Unrelated DeepSeek generations return null so
 * existing non-V4 provider routing remains unchanged.
 */
export function resolveDeepSeekRoute(modelId: string): DeepSeekRoute | null {
  const normalized = modelId.trim().toLowerCase()
  const descriptor = DEEPSEEK_MODEL_DESCRIPTORS.find(
    candidate => candidate.id === normalized || candidate.aliases.includes(normalized),
  )
  if (descriptor) return { platform: descriptor.platform, model: descriptor.model }

  if (!/^(?:(?:official|bailian)\/)?deepseek-/i.test(normalized)) return null
  const supportedIds = DEEPSEEK_MODEL_DESCRIPTORS.flatMap(candidate => [candidate.id, ...candidate.aliases])
  const hint = normalized.endsWith('-0731')
    ? " Use 'bailian/deepseek-v4-flash-0731' for the dated Bailian model."
    : ''
  throw new Error(
    `Unsupported DeepSeek model '${modelId}'. Supported ids: ${supportedIds.join(', ')}.${hint}`,
  )
}

/** Models advertised by this gateway; no remote catalog pollution. */
export function listDeepSeekModels(): DeepSeekModelDescriptor[] {
  return DEEPSEEK_MODEL_DESCRIPTORS.filter(
    descriptor => !!process.env[descriptor.credentialEnvironmentVariable],
  ).map(descriptor => ({ ...descriptor, aliases: [...descriptor.aliases], thinkingEfforts: [...descriptor.thinkingEfforts] }))
}
