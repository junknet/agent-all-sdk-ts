import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolveDeepSeekRoute } from '../src/deepseek_routes.js'
import { resolveModel } from '../src/index.js'
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
      'gemini-3.6-flash-high',
      'gpt-5.6-sol',
      'claude-opus-5',
    ])
    expect(models.every(model => model.name === model.id)).toBe(true)
  })

  test('publishes credential-backed DeepSeek descriptors from the routing source of truth', () => {
    process.env.DASHSCOPE_API_KEY = 'test-only'
    const models = buildAvailableModelCatalog({ antigravity: [], codex: [], claude: [] })
    expect(models.map(model => model.id)).toEqual(['bailian/deepseek-v4-flash-0731'])
    expect(resolveDeepSeekRoute(models[0]!.id)).toEqual({
      platform: 'bailian',
      model: 'deepseek-v4-flash-0731',
    })
  })

  test('serializes an OMP-compatible list plus explicit gateway capabilities', () => {
    const response = createModelsListResponse(buildAvailableModelCatalog(sources))
    expect(response.object).toBe('list')
    expect(response.data[0]).toMatchObject({
      id: 'gemini-3.6-flash-high',
      name: 'gemini-3.6-flash-high',
      object: 'model',
      owned_by: 'local-gw',
      supported_endpoint_types: ['anthropic', 'openai'],
      context_length: 1_048_576,
      max_output_tokens: 65_536,
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

  test('DeepSeek catalog ids are never rewritten to Gemini by the text escalation trigger', () => {
    for (const model of [
      'deepseek-v4-flash',
      'official/deepseek-v4-flash',
      'bailian/deepseek-v4-flash-0731',
    ]) {
      expect(resolveModel(model, 'think hard')).toEqual({ model, escalated: false })
    }
  })

})
