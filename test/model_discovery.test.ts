import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolveDeepSeekRoute } from '../src/deepseek_routes.js'
import { findRegistryEntry } from '../src/model_registry.js'
import { resolveModel } from '../src/index.js'
import { parseCcRelayModels } from '../src/cc_relay.js'
import {
  buildAvailableModelCatalog,
  createModelsListResponse,
  type CatalogSources,
} from '../src/model_catalog.js'

const sources: CatalogSources = {
  antigravity: [
    { id: 'gemini-3.6-flash-high', name: 'upstream display name' },
    { id: 'gemini-2.5-flash', name: 'legacy model' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.4', name: 'legacy model' },
  ],
  claude: [
    { id: 'claude-opus-5', name: 'Claude Opus 5' },
    { id: 'claude-opus-4-7', name: 'legacy model' },
  ],
}

let previousDeepSeekKey: string | undefined
let previousDashScopeKey: string | undefined

beforeEach(() => {
  previousDeepSeekKey = process.env.DEEPSEEK_API_KEY
  previousDashScopeKey = process.env.DASHSCOPE_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.DASHSCOPE_API_KEY
})

afterEach(() => {
  if (previousDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = previousDeepSeekKey
  if (previousDashScopeKey === undefined) delete process.env.DASHSCOPE_API_KEY
  else process.env.DASHSCOPE_API_KEY = previousDashScopeKey
})

describe('/v1/models discovery contract', () => {
  test('publishes only gateway-approved, currently available provider models', () => {
    const models = buildAvailableModelCatalog(sources)
    expect(models.map(model => model.id)).toEqual([
      'local-gemini-3.6-flash-high',
      'local-gpt-5.6-sol',
      'local-claude-opus-5',
    ])
    expect(models.every(model => model.name === model.id)).toBe(true)
  })

  test('merges the relay catalog alongside local models under distinct ids', () => {
    const models = buildAvailableModelCatalog({
      ...sources,
      ccr: [
        { id: 'claude-opus-5', name: 'Opus 5' },
        { id: 'kimi-k3', name: 'KIMI k3' },
      ],
    })
    const ids = models.map(model => model.id)

    // Both channels publish an "Opus 5"; only the prefix keeps them apart.
    expect(ids).toContain('local-claude-opus-5')
    expect(ids).toContain('ccr-claude-opus-5')
    expect(ids).toContain('ccr-kimi-k3')
    expect(new Set(ids).size).toBe(ids.length)
    // A relay id the registry does not publish stays out of the catalog.
    expect(ids).not.toContain('ccr-claude-opus-4-6')
  })

  test('omits relay models entirely when the relay catalog is unavailable', () => {
    const ids = buildAvailableModelCatalog(sources).map(model => model.id)
    expect(ids.some(id => id.startsWith('ccr-'))).toBe(false)
  })

  test('publishes credential-backed DeepSeek descriptors from the routing source of truth', () => {
    process.env.DASHSCOPE_API_KEY = 'test-only'
    const models = buildAvailableModelCatalog({ antigravity: [], codex: [], claude: [] })
    // Only the Bailian entry: official/* needs DEEPSEEK_API_KEY, cleared above.
    expect(models.map(model => model.id)).toEqual(['bailian-deepseek-v4-flash-0731'])
    expect(findRegistryEntry(models[0]!.id)).toMatchObject({
      channel: 'bailian',
      upstream: 'deepseek-v4-flash-0731',
    })
    // The legacy router now only answers to bare ids, and a bare id cannot
    // express a platform, so it always means the official API.
    expect(resolveDeepSeekRoute('deepseek-v4-pro')).toEqual({
      platform: 'official',
      model: 'deepseek-v4-pro',
    })
    // The dated weights exist only on Bailian, so the bare form must not
    // silently resolve to a same-looking official model.
    expect(() => resolveDeepSeekRoute('deepseek-v4-flash-0731')).toThrow(/bailian-/)
  })

  test('publishes the Windsurf Outbox only when its local login is available', () => {
    const unavailable = buildAvailableModelCatalog({ antigravity: [], codex: [], claude: [], windsurf: false })
    expect(unavailable.some(model => model.id === 'windsurf-claude-sonnet-5-medium')).toBe(false)

    const available = buildAvailableModelCatalog({ antigravity: [], codex: [], claude: [], windsurf: true })
    expect(available.find(model => model.id === 'windsurf-claude-sonnet-5-medium')).toMatchObject({
      supportsImages: true,
      supportsTools: true,
      contextWindow: 1000000,
      maxOutputTokens: 1000000,
      thinkingEfforts: ['medium'],
      defaultThinkingEffort: 'medium',
      canDisableThinking: false,
    })
  })

  test('serializes an OMP-compatible list plus explicit gateway capabilities', () => {
    const response = createModelsListResponse(buildAvailableModelCatalog(sources))
    expect(response.object).toBe('list')
    expect(response.data[0]).toMatchObject({
      id: 'local-gemini-3.6-flash-high',
      name: 'local-gemini-3.6-flash-high',
      object: 'model',
      owned_by: 'local-gw',
      supported_endpoint_types: ['anthropic', 'openai'],
      context_length: 1_000_000,
      max_output_tokens: 1_000_000,
      capabilities: {
        inputModalities: ['text', 'image'],
        tools: true,
        thinking: true,
        thinkingEfforts: ['high'],
        defaultThinkingEffort: 'high',
        canDisableThinking: false,
        protocols: ['anthropic-messages', 'openai-chat', 'openai-responses'],
      },
    })
    expect(new Set(response.data.map(model => model.id)).size).toBe(response.data.length)
  })

  test('keeps a relay-discovered model visible without inventing absent limits', () => {
    const response = createModelsListResponse([
      { id: 'kimi-k3', name: 'KIMI k3', clientProtocol: 'openai_chat_completions' },
    ])

    expect(response.data).toEqual([
      expect.objectContaining({ id: 'kimi-k3', name: 'KIMI k3' }),
    ])
    expect(response.data[0]?.context_length).toBeUndefined()
    expect(response.data[0]?.max_output_tokens).toBeUndefined()
  })

  test('retains every relay-published model with its declared outbox protocol', () => {
    const models = parseCcRelayModels({
      data: [
        { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', client_protocol: 'anthropic_messages' },
        { id: 'gpt-5-4', display_name: 'GPT-5.4', client_protocol: 'openai_responses' },
        { id: 'kimi-k3', display_name: 'Kimi K3', client_protocol: 'openai_chat_completions' },
      ],
    })

    expect(models).toEqual([
      { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', clientProtocol: 'anthropic_messages' },
      { id: 'gpt-5-4', name: 'GPT-5.4', clientProtocol: 'openai_responses' },
      { id: 'kimi-k3', name: 'Kimi K3', clientProtocol: 'openai_chat_completions' },
    ])
  })

  test('cc-relay mode preserves published model ids without local remapping', () => {
    const previous = process.env.CC_RELAY_PROTOCOL_AWARE
    try {
      process.env.CC_RELAY_PROTOCOL_AWARE = '1'
      expect(resolveModel('claude-haiku-5', 'think hard')).toEqual({
        model: 'claude-haiku-5',
        escalated: false,
      })
    } finally {
      if (previous === undefined) delete process.env.CC_RELAY_PROTOCOL_AWARE
      else process.env.CC_RELAY_PROTOCOL_AWARE = previous
    }
  })

  test('DeepSeek catalog ids are never rewritten to Gemini by the text escalation trigger', () => {
    for (const model of [
      'deepseek-v4-flash',
      'official-deepseek-v4-flash',
      'bailian-deepseek-v4-flash-0731',
    ]) {
      expect(resolveModel(model, 'think hard')).toEqual({ model, escalated: false })
    }
  })

})
