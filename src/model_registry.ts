/**
 * Channel-qualified model registry.
 *
 * `model_registry.yaml` is the single source of truth for which ids this
 * gateway publishes and what each one can do.  Provider catalogs only prove
 * that an upstream model is *reachable*; they never decide the public id, and
 * for cc-relay they carry no capability metadata at all.
 *
 * Every published id is `<channel>-<model>`.  The prefix names the outbox
 * channel rather than the model family, because the same weights reached
 * through different channels are different products: `local-claude-opus-5`
 * spends a local OAuth subscription while `ccr-claude-opus-5` spends relay
 * credit.  Collapsing them onto one id would also make the merged catalog
 * ambiguous — both channels publish four identically named Claude models.
 *
 * The separator is `-`, not `/`: OMP's proxy discovery silently drops catalog
 * entries whose id contains a slash (verified against a fixture serving both
 * shapes — only the dashed id was ever selected), because it reserves `/` for
 * the `provider/model` level.
 */

import { readFileSync } from 'fs'
import * as path from 'path'
import type { ModelInfo, ThinkingEffort } from './types.js'

export type RegistryChannel = 'local' | 'windsurf' | 'ccr' | 'official' | 'bailian' | 'openrouter'

/** Availability probe that gates a `local` entry; other channels are env-gated. */
export type RegistrySource = 'antigravity' | 'codex' | 'claude'

export interface RegistryThinking {
  readonly efforts: readonly ThinkingEffort[]
  readonly default: ThinkingEffort
  readonly canDisable: boolean
}

export interface RegistryEntry {
  /** Public, channel-qualified id. Unique across the whole catalog. */
  readonly id: string
  readonly channel: RegistryChannel
  /** Present only for `local`: which provider catalog proves availability. */
  readonly source?: RegistrySource
  /** Id sent upstream, i.e. the public id with its channel prefix removed. */
  readonly upstream: string
  readonly images: boolean
  readonly tools: boolean
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly thinking?: RegistryThinking
  /** False when the numbers are same-family estimates rather than measured. */
  readonly verified: boolean
}

const CHANNELS: readonly RegistryChannel[] = [
  'local',
  'windsurf',
  'ccr',
  'official',
  'bailian',
  'openrouter',
]
const SOURCES: readonly RegistrySource[] = ['antigravity', 'codex', 'claude']
const EFFORTS: readonly ThinkingEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

function fail(id: string, message: string): never {
  throw new Error(`model_registry.yaml: '${id}' ${message}`)
}

/**
 * Map an upstream model id onto the dash-only suffix a published id must use.
 * OpenRouter ids are `vendor/model[:variant]` (e.g.
 * `deepseek/deepseek-v4-flash-20260731:nitro`); '/' and ':' become '-' so the
 * published id stays dash-only (see file header on why '/' is unsafe).
 */
export function sanitizeUpstreamForId(upstream: string): string {
  return upstream.replace(/[/:]/g, '-')
}

function requirePositiveInt(value: unknown, id: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(id, `has a non-positive ${field}: ${JSON.stringify(value)}`)
  }
  return value
}

function parseThinking(raw: unknown, id: string): RegistryThinking | undefined {
  if (raw === undefined) return undefined
  if (!raw || typeof raw !== 'object') fail(id, 'has a malformed thinking block')
  const record = raw as Record<string, unknown>
  const efforts = record.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) {
    fail(id, 'declares thinking without a non-empty efforts list')
  }
  for (const effort of efforts) {
    if (!EFFORTS.includes(effort as ThinkingEffort)) {
      fail(id, `declares an unknown thinking effort: ${JSON.stringify(effort)}`)
    }
  }
  const fallback = record.default
  if (!EFFORTS.includes(fallback as ThinkingEffort)) {
    fail(id, `declares an unknown default effort: ${JSON.stringify(fallback)}`)
  }
  // A default outside the supported set would make the gateway advertise an
  // effort the upstream rejects, which surfaces downstream as an opaque 400.
  if (!efforts.includes(fallback)) {
    fail(id, `declares default '${String(fallback)}' outside its own efforts list`)
  }
  if (typeof record.canDisable !== 'boolean') {
    fail(id, 'declares thinking without an explicit canDisable')
  }
  return {
    efforts: efforts as ThinkingEffort[],
    default: fallback as ThinkingEffort,
    canDisable: record.canDisable,
  }
}

function parseEntry(raw: unknown, seen: Set<string>): RegistryEntry {
  if (!raw || typeof raw !== 'object') {
    throw new Error('model_registry.yaml: models[] contains a non-object entry')
  }
  const record = raw as Record<string, unknown>
  const id = record.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('model_registry.yaml: models[] contains an entry without an id')
  }
  if (seen.has(id)) fail(id, 'is declared more than once')
  seen.add(id)

  const channel = record.channel
  if (!CHANNELS.includes(channel as RegistryChannel)) {
    fail(id, `has an unknown channel: ${JSON.stringify(channel)}`)
  }
  // The prefix is not decoration: routing reads the channel back off the id,
  // so an id that disagrees with its channel field would route somewhere else
  // than the catalog claims.
  if (!id.startsWith(`${String(channel)}-`)) {
    fail(id, `does not start with its own channel prefix '${String(channel)}-'`)
  }

  const upstream = record.upstream
  if (typeof upstream !== 'string' || upstream.length === 0) {
    fail(id, 'has no upstream model id')
  }
  // The published id must stay dash-only (OMP proxy discovery drops any id
  // containing '/', see file header), but some upstreams — OpenRouter's
  // `vendor/model[:variant]` — are not dash-only themselves. The id suffix is
  // therefore the upstream string with '/' and ':' sanitized to '-'; every
  // existing upstream is already dash-only, so this is a no-op for them.
  const idSuffix = sanitizeUpstreamForId(upstream as string)
  if (id.slice(String(channel).length + 1) !== idSuffix) {
    fail(id, `disagrees with its upstream id '${upstream}'`)
  }

  const source = record.source
  if (channel === 'local') {
    if (!SOURCES.includes(source as RegistrySource)) {
      fail(id, `is a local model with an unknown source: ${JSON.stringify(source)}`)
    }
  } else if (source !== undefined) {
    fail(id, `is not local but declares a source: ${JSON.stringify(source)}`)
  }

  if (typeof record.images !== 'boolean') fail(id, 'has no explicit images flag')
  if (typeof record.tools !== 'boolean') fail(id, 'has no explicit tools flag')
  if (typeof record.verified !== 'boolean') fail(id, 'has no explicit verified flag')

  return {
    id,
    channel: channel as RegistryChannel,
    ...(channel === 'local' ? { source: source as RegistrySource } : {}),
    upstream,
    images: record.images,
    tools: record.tools,
    contextWindow: requirePositiveInt(record.contextWindow, id, 'contextWindow'),
    maxOutputTokens: requirePositiveInt(record.maxOutputTokens, id, 'maxOutputTokens'),
    thinking: parseThinking(record.thinking, id),
    verified: record.verified,
  }
}

/** Parse and validate a registry document. Exported so tests can feed fixtures. */
export function parseModelRegistry(document: unknown): RegistryEntry[] {
  if (!document || typeof document !== 'object') {
    throw new Error('model_registry.yaml: document is not a mapping')
  }
  const models = (document as { models?: unknown }).models
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('model_registry.yaml: models[] is missing or empty')
  }
  const seen = new Set<string>()
  return models.map(entry => parseEntry(entry, seen))
}

let cached: readonly RegistryEntry[] | undefined

/**
 * Load the registry once per process.  A malformed file throws at first use so
 * the gateway fails loudly at startup instead of silently publishing a catalog
 * that routes requests to the wrong channel.
 */
export function listRegistry(): readonly RegistryEntry[] {
  if (!cached) {
    const file = path.join(import.meta.dir, 'model_registry.yaml')
    cached = parseModelRegistry(Bun.YAML.parse(readFileSync(file, 'utf-8')))
  }
  return cached
}

export function findRegistryEntry(modelId: string): RegistryEntry | undefined {
  const wanted = modelId.trim()
  return listRegistry().find(entry => entry.id === wanted)
}

/**
 * True for any id carrying a known channel prefix, valid or not.
 *
 * Matched against the fixed channel list rather than by splitting on the first
 * `-`, since every model name contains dashes of its own.
 */
export function hasChannelPrefix(modelId: string): boolean {
  return CHANNELS.some(channel => modelId.startsWith(`${channel}-`))
}

/**
 * Strip the channel prefix for the wire.
 *
 * The prefix exists to pick an outbox; no upstream knows about it.  Providers
 * that re-read `req.model` when building their request (antigravity resolves it
 * through its own route table) would otherwise send `local/gemini-3.6-flash-low`
 * upstream and get a 404 for a model nobody publishes.
 */
export function upstreamModelId(modelId: string | undefined): string {
  const model = modelId ?? ''
  return findRegistryEntry(model)?.upstream ?? model
}

export function registryEntriesForChannel(channel: RegistryChannel): RegistryEntry[] {
  return listRegistry().filter(entry => entry.channel === channel)
}

export function toModelInfo(entry: RegistryEntry): ModelInfo {
  return {
    id: entry.id,
    name: entry.id,
    supportsImages: entry.images,
    supportsTools: entry.tools,
    supportsThinking: !!entry.thinking,
    ...(entry.thinking
      ? {
          thinkingEfforts: [...entry.thinking.efforts],
          defaultThinkingEffort: entry.thinking.default,
          canDisableThinking: entry.thinking.canDisable,
        }
      : { canDisableThinking: false }),
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
  }
}
