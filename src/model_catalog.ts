import { detectLocalCredits } from './auth.js'
import { createAnthropicPassthroughProvider } from './providers/anthropic_passthrough_provider.js'
import {
  createAntigravityProvider,
  ANTIGRAVITY_DEFAULT_MODEL,
} from './providers/antigravity_provider.js'
import { CODEX_MODELS } from './providers/codex_models.js'
import { createOpenaiCompatProvider } from './providers/openai_compat_provider.js'
import { windsurfCredentialsAreAvailable } from './providers/windsurf_agent_ir_provider.js'
import type { ModelInfo, ThinkingEffort } from './types.js'
import { isCcRelayProtocolAware, listCcRelayModels } from './cc_relay.js'
import {
  listRegistry,
  toModelInfo,
  type RegistryEntry,
  type RegistrySource,
} from './model_registry.js'
import { createGatewayLogger } from './logging.js'

type CatalogSource = RegistrySource

export interface CatalogSources {
  readonly antigravity: readonly ModelInfo[]
  readonly codex: readonly ModelInfo[]
  readonly claude: readonly ModelInfo[]
  /** Local Devin/Windsurf login makes the Windsurf Outbox available. */
  readonly windsurf?: boolean
  /** Relay-published ids, absent when cc-relay outbox is not configured. */
  readonly ccr?: readonly ModelInfo[]
}

export interface GatewayModelCapabilities {
  readonly inputModalities: readonly ('text' | 'image')[]
  readonly tools: boolean
  readonly thinking: boolean
  readonly thinkingEfforts: readonly ThinkingEffort[]
  readonly defaultThinkingEffort?: ThinkingEffort
  readonly canDisableThinking: boolean
  readonly protocols: readonly ('anthropic-messages' | 'openai-chat' | 'openai-responses')[]
}

export interface GatewayModelObject {
  readonly id: string
  readonly object: 'model'
  readonly created: 0
  readonly owned_by: 'local-gw'
  readonly name: string
  readonly supported_endpoint_types: readonly ['anthropic', 'openai']
  readonly context_length?: number
  readonly context_window?: number
  readonly max_input_tokens?: number
  readonly max_output_tokens?: number
  readonly capabilities: GatewayModelCapabilities
}

export interface GatewayModelsList {
  readonly object: 'list'
  readonly data: readonly GatewayModelObject[]
}

function idsOf(models: readonly ModelInfo[]): ReadonlySet<string> {
  return new Set(models.map(model => model.id))
}

/**
 * Availability for one registry entry.
 *
 * The registry decides *what may be published*; this decides *what is reachable
 * right now*.  Both must agree, so a relay outage or an expired subscription
 * removes ids from the catalog instead of leaving them advertised and broken.
 */
function isReachable(
  entry: RegistryEntry,
  available: Readonly<Record<CatalogSource, ReadonlySet<string>>>,
  relayIds: ReadonlySet<string>,
  windsurfAvailable: boolean,
): boolean {
  switch (entry.channel) {
    case 'local':
      return available[entry.source!].has(entry.upstream)
    case 'ccr':
      return relayIds.has(entry.upstream)
    case 'windsurf':
      return windsurfAvailable
    case 'official':
      return !!process.env.DEEPSEEK_API_KEY
    case 'bailian':
      return !!process.env.DASHSCOPE_API_KEY
    case 'openrouter':
      return !!process.env.OPENROUTER_API_KEY
  }
}

/**
 * Apply gateway policy to provider availability snapshots.
 *
 * Local and relay catalogs are merged rather than one shadowing the other:
 * both channels publish four identically named Claude models, and the channel
 * prefix is what keeps the merged ids unique and the routing unambiguous.
 */
export function buildAvailableModelCatalog(sources: CatalogSources): ModelInfo[] {
  const available: Readonly<Record<CatalogSource, ReadonlySet<string>>> = {
    antigravity: idsOf(sources.antigravity),
    codex: idsOf(sources.codex),
    claude: idsOf(sources.claude),
  }
  const relayIds = idsOf(sources.ccr ?? [])
  return listRegistry()
    .filter(entry => isReachable(entry, available, relayIds, sources.windsurf ?? false))
    .map(toModelInfo)
}

export type CatalogDiscoverySource = CatalogSource | 'ccr' | 'openai_compat'

export const MODEL_CATALOG_DISCOVERY_TIMEOUT_MS = 5_000
export const MODEL_CATALOG_SUCCESS_TTL_MS = 15_000
export const MODEL_CATALOG_FAILURE_TTL_MS = 5_000

export interface ProviderCatalogCacheOptions {
  readonly now?: () => number
  readonly discoveryTimeoutMs?: number
  readonly successTtlMs?: number
  readonly failureTtlMs?: number
  readonly reportFailure?: (source: CatalogDiscoverySource, error: unknown) => void
}

export interface ProviderCatalogCache {
  load(
    source: CatalogDiscoverySource,
    discover: () => Promise<readonly ModelInfo[]>,
  ): Promise<readonly ModelInfo[]>
}

interface CachedProviderCatalog {
  readonly expiresAt: number
  readonly models: readonly ModelInfo[]
}

function nonNegativeMilliseconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite, non-negative number of milliseconds`)
  }
  return value
}

function positiveMilliseconds(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a finite, positive number of milliseconds`)
  }
  return value
}

function withDiscoveryTimeout<T>(
  source: CatalogDiscoverySource,
  timeoutMs: number,
  discover: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`model catalog discovery for ${source} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    Promise.resolve()
      .then(discover)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer))
  })
}

/**
 * Bounds each provider discovery and remembers both usable and failed snapshots.
 *
 * The cache is an instance rather than a module-global test hook: production owns
 * one instance below, while each test can provide its own clock and cache state.
 */
export function createProviderCatalogCache(options: ProviderCatalogCacheOptions = {}): ProviderCatalogCache {
  const now = options.now ?? Date.now
  const discoveryTimeoutMs = positiveMilliseconds(
    options.discoveryTimeoutMs ?? MODEL_CATALOG_DISCOVERY_TIMEOUT_MS,
    'discoveryTimeoutMs',
  )
  const successTtlMs = nonNegativeMilliseconds(
    options.successTtlMs ?? MODEL_CATALOG_SUCCESS_TTL_MS,
    'successTtlMs',
  )
  const failureTtlMs = nonNegativeMilliseconds(
    options.failureTtlMs ?? MODEL_CATALOG_FAILURE_TTL_MS,
    'failureTtlMs',
  )
  const catalogLogger = createGatewayLogger()
  const reportFailure = options.reportFailure ?? ((source: CatalogDiscoverySource, error: unknown) => {
    catalogLogger.warn(
      { event: 'model_catalog.discovery_failed', source, error },
      'Provider model catalog discovery failed',
    )
  })
  const cached = new Map<CatalogDiscoverySource, CachedProviderCatalog>()
  const pending = new Map<CatalogDiscoverySource, Promise<readonly ModelInfo[]>>()

  return {
    async load(source, discover) {
      const previous = cached.get(source)
      if (previous && previous.expiresAt > now()) return previous.models

      const inFlight = pending.get(source)
      if (inFlight) return inFlight

      const refresh = withDiscoveryTimeout(source, discoveryTimeoutMs, discover)
        .then(models => {
          cached.set(source, { models, expiresAt: now() + successTtlMs })
          return models
        })
        .catch(error => {
          reportFailure(source, error)
          const unavailable: readonly ModelInfo[] = []
          cached.set(source, { models: unavailable, expiresAt: now() + failureTtlMs })
          return unavailable
        })
      pending.set(source, refresh)

      try {
        return await refresh
      } finally {
        if (pending.get(source) === refresh) pending.delete(source)
      }
    },
  }
}

const providerCatalogCache = createProviderCatalogCache()

async function isolateCatalog(
  source: CatalogDiscoverySource,
  load: () => Promise<readonly ModelInfo[]>,
): Promise<readonly ModelInfo[]> {
  return providerCatalogCache.load(source, load)
}

const truthy = (v: string | undefined): boolean => !!v && !['0', 'false', 'no', ''].includes(v.toLowerCase())

/** Query independent provider catalogs concurrently, then apply gateway policy. */
export async function listAvailableModels(): Promise<ModelInfo[]> {
  if (truthy(process.env.FORCE_OPENAI_COMPAT)) {
    const forcedModel = process.env.OPENAI_MODEL ?? process.env.OPENAI_COMPAT_MODEL
    const provider = createOpenaiCompatProvider({
      baseURL: process.env.OPENAI_BASE_URL ?? '',
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: forcedModel ?? '',
      authScheme: process.env.OPENAI_COMPAT_AUTH_SCHEME === 'x-api-key' ? 'x-api-key' : 'bearer',
    })
    const fetched = await isolateCatalog('openai_compat', async () => (await provider.listModels?.()) ?? [])
    const models = fetched.filter(model =>
      model.clientProtocol === undefined || model.clientProtocol === 'openai_chat_completions',
    )
    if (forcedModel && !models.some(m => m.id === forcedModel)) {
      models.unshift({
        id: forcedModel,
        name: forcedModel,
        contextWindow: 1048576,
        maxOutputTokens: 128000,
        supportsTools: true,
        supportsImages: true,
      })
    }
    return models
  }

  const credits = detectLocalCredits()
  const codexCredit = credits.find(credit => credit.provider === 'codex')
  const claudeCredit = credits.find(credit => credit.provider === 'claude')

  const [antigravity, codex, claude, ccr] = await Promise.all([
    isolateCatalog('antigravity', async () => {
      const provider = createAntigravityProvider({ model: ANTIGRAVITY_DEFAULT_MODEL })
      await provider.prepare?.()
      return (await provider.listModels?.()) ?? []
    }),
    isolateCatalog('codex', async () => codexCredit?.type === 'oauth' && codexCredit.source
      ? CODEX_MODELS.map(model => ({ id: model.id, name: model.label }))
      : []),
    isolateCatalog('claude', async () => {
      if (!claudeCredit) return []
      const provider = createAnthropicPassthroughProvider({
        // Never inherit ANTHROPIC_BASE_URL here: when cc-relay outbox is
        // configured it points at the relay, which would make the *local*
        // channel probe the relay and republish relay models as local ones.
        baseURL: 'https://api.anthropic.com',
        apiKey: claudeCredit.type === 'api_key' ? (claudeCredit.value ?? '') : '',
        model: 'claude-opus-5',
        ...(claudeCredit.type === 'oauth' && claudeCredit.source
          ? { source: claudeCredit.source }
          : {}),
      })
      await provider.prepare?.()
      return (await provider.listModels?.()) ?? []
    }),
    isolateCatalog('ccr', async () => (isCcRelayProtocolAware() ? listCcRelayModels() : [])),
  ])

  return buildAvailableModelCatalog({
    antigravity,
    codex,
    claude,
    ccr,
    windsurf: windsurfCredentialsAreAvailable(),
  })
}

function positive(value: number | undefined, field: string, modelId: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Cannot publish model '${modelId}': ${field} must be a positive number`)
  }
  return value
}

export function createModelsListResponse(models: readonly ModelInfo[]): GatewayModelsList {
  const seen = new Set<string>()
  const data = models.map(model => {
    if (!model.id || seen.has(model.id)) {
      throw new Error(`Cannot publish duplicate or empty model id '${model.id}'`)
    }
    seen.add(model.id)
    const thinking = model.supportsThinking ?? false
    const contextWindow =
      typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow)
        ? positive(model.contextWindow, 'contextWindow', model.id)
        : undefined
    const maxOutputTokens =
      typeof model.maxOutputTokens === 'number' && Number.isFinite(model.maxOutputTokens)
        ? positive(model.maxOutputTokens, 'maxOutputTokens', model.id)
        : undefined
    return {
      id: model.id,
      object: 'model' as const,
      created: 0 as const,
      owned_by: 'local-gw' as const,
      // Deliberately exact: the selector shown to a user is also the routed id.
      name: model.name,
      supported_endpoint_types: ['anthropic', 'openai'] as const,
      ...(contextWindow
        ? {
            context_length: contextWindow,
            context_window: contextWindow,
            max_input_tokens: contextWindow,
          }
        : {}),
      ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
      capabilities: {
        inputModalities: model.supportsImages ? (['text', 'image'] as const) : (['text'] as const),
        tools: model.supportsTools ?? true,
        thinking,
        thinkingEfforts: thinking ? (model.thinkingEfforts ?? []) : [],
        ...(model.defaultThinkingEffort
          ? { defaultThinkingEffort: model.defaultThinkingEffort }
          : {}),
        canDisableThinking: thinking && (model.canDisableThinking ?? false),
        protocols: ['anthropic-messages', 'openai-chat', 'openai-responses'] as const,
      },
    }
  })
  return { object: 'list', data }
}
