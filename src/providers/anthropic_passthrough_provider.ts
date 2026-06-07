/**
 * Anthropic passthrough provider
 */

import type {
  AnthropicMessagesRequest,
  WireProvider,
  WirePreparedRequest,
  ModelInfo,
  QuotaInfo,
} from '../types.js'
import type { AnthropicEventEmitter } from '../emitter.js'
import type { TokenSource } from '../auth.js'

export interface AnthropicPassthroughOpts {
  baseURL: string
  apiKey: string
  model: string
  source?: TokenSource
}

// OAuth (Claude Max/Pro) and API-key are two distinct auth modes on the Anthropic
// wire: OAuth tokens (sk-ant-oat01-…) MUST go as `Authorization: Bearer` with the
// claude-code oauth beta flags and `?beta=true`; sending them as x-api-key 401s.
// API keys go as `x-api-key`. (PROTOCOL_REFERENCE §1.2)
const OAUTH_BETA =
  'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,fine-grained-tool-streaming-2025-05-14'

export function createAnthropicPassthroughProvider(
  opts: AnthropicPassthroughOpts,
): WireProvider {
  const isOAuth = !!opts.source

  const resolveKey = async (): Promise<string> => (opts.source ? opts.source.token() : opts.apiKey)

  const authHeaders = (key: string): Record<string, string> => {
    if (isOAuth) {
      return {
        Authorization: `Bearer ${key}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA,
        'x-app': 'cli',
      }
    }
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  }

  const messagesUrl = (): string => {
    const baseURL = opts.baseURL.replace(/\/$/, '')
    const path = baseURL.endsWith('/v1') ? `${baseURL}/messages` : `${baseURL}/v1/messages`
    return isOAuth ? `${path}?beta=true` : path
  }

  return {
    name: 'anthropic-passthrough',

    async buildRequest(req: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const body = { ...req, model: opts.model || req.model }
      const key = await resolveKey()
      return {
        url: messagesUrl(),
        headers: { 'Content-Type': 'application/json', ...authHeaders(key) },
        body: JSON.stringify(body),
      }
    },

    async parseStream(response: Response, emitter: AnthropicEventEmitter): Promise<void> {
      const reader = response.body?.getReader()
      if (!reader) {
        emitter.start({ model: opts.model })
        emitter.error(new Error('anthropic-passthrough: empty response body'))
        return
      }
      const decoder = new TextDecoder()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) {
            emitter.emitRawChunk(decoder.decode(value, { stream: true }))
          }
        }
      } finally {
        try {
          reader.releaseLock()
        } catch {}
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      const baseURL = opts.baseURL.replace(/\/$/, '')
      const url = baseURL.endsWith('/v1')
        ? `${baseURL}/models`
        : `${baseURL}/v1/models`

      const key = await resolveKey()
      const res = await fetch(url, {
        method: 'GET',
        headers: authHeaders(key),
      })
      if (!res.ok) {
        // Fallback to basic list
        return [
          { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' },
          { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        ]
      }
      const data = (await res.json()) as any
      const list = data.data || []
      return list.map((m: any) => ({
        id: m.id,
        name: m.display_name || m.id,
      }))
    },

    async getQuota(): Promise<QuotaInfo> {
      if (opts.source && opts.source.getQuota) {
        return opts.source.getQuota()
      }
      return {
        planType: 'anthropic-free',
      }
    },
  }
}
