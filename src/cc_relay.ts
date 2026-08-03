/**
 * cc-relay protocol-aware routing.
 *
 * The relay owns the model-to-protocol contract through GET /v1/models.  Keep
 * that contract here rather than duplicating model families in the gateway.
 */

import type { ClientProtocol, ModelInfo } from './types.js'

export interface CcRelayConfig {
  readonly baseURL: string
  readonly apiKey: string
}

interface CachedCatalog {
  readonly expiresAt: number
  readonly models: readonly ModelInfo[]
}

const CATALOG_TTL_MS = 30_000
let cachedCatalog: CachedCatalog | undefined
let pendingCatalog: Promise<readonly ModelInfo[]> | undefined

function enabled(value: string | undefined): boolean {
  return !!value && !['0', 'false', 'no', ''].includes(value.toLowerCase())
}

export function isCcRelayProtocolAware(): boolean {
  return enabled(process.env.CC_RELAY_PROTOCOL_AWARE)
}

export function ccRelayConfig(): CcRelayConfig {
  const baseURL = (process.env.CC_RELAY_BASE_URL ?? process.env.ANTHROPIC_BASE_URL ?? '')
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')
  const apiKey = process.env.CC_RELAY_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''
  if (!baseURL || !apiKey) {
    throw new Error('CC_RELAY_PROTOCOL_AWARE requires CC_RELAY_BASE_URL/CC_RELAY_API_KEY or ANTHROPIC_BASE_URL/ANTHROPIC_API_KEY')
  }
  return { baseURL, apiKey }
}

function clientProtocol(value: unknown): ClientProtocol | undefined {
  if (
    value === 'anthropic_messages' ||
    value === 'openai_chat_completions' ||
    value === 'openai_responses'
  ) {
    return value
  }
  return undefined
}

/** Parse relay models without inventing capability or token-limit metadata. */
export function parseCcRelayModels(payload: unknown): ModelInfo[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  return data.flatMap((item): ModelInfo[] => {
    if (!item || typeof item !== 'object') return []
    const record = item as { id?: unknown; display_name?: unknown; client_protocol?: unknown }
    if (typeof record.id !== 'string' || record.id.length === 0) return []
    return [{
      id: record.id,
      name: typeof record.display_name === 'string' && record.display_name.length > 0
        ? record.display_name
        : record.id,
      clientProtocol: clientProtocol(record.client_protocol),
    }]
  })
}

export async function listCcRelayModels(): Promise<readonly ModelInfo[]> {
  const now = Date.now()
  if (cachedCatalog && cachedCatalog.expiresAt > now) return cachedCatalog.models
  if (pendingCatalog) return pendingCatalog

  const { baseURL, apiKey } = ccRelayConfig()
  pendingCatalog = (async () => {
    const response = await fetch(`${baseURL}/v1/models`, {
      headers: { 'x-api-key': apiKey },
    })
    if (!response.ok) {
      throw new Error(`cc-relay model catalog failed: HTTP ${response.status}`)
    }
    const models = parseCcRelayModels(await response.json())
    if (models.length === 0) throw new Error('cc-relay model catalog contains no valid models')
    cachedCatalog = { expiresAt: Date.now() + CATALOG_TTL_MS, models }
    return models
  })()

  try {
    return await pendingCatalog
  } finally {
    pendingCatalog = undefined
  }
}

export async function ccRelayProtocolForModel(model: string): Promise<ClientProtocol> {
  const found = (await listCcRelayModels()).find(candidate => candidate.id === model)
  if (!found?.clientProtocol) {
    throw new Error(`Model is not published by cc-relay with a protocol: ${model}`)
  }
  return found.clientProtocol
}
