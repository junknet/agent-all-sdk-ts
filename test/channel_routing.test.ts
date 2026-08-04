import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { listRegistry, parseModelRegistry } from '../src/model_registry.js'
import { pickRegistryWireProvider, resolveModel } from '../src/index.js'

const validEntry = {
  id: 'ccr-kimi-k3',
  channel: 'ccr',
  upstream: 'kimi-k3',
  images: false,
  tools: true,
  contextWindow: 131072,
  maxOutputTokens: 32768,
  verified: false,
}

describe('model registry validation', () => {
  test('every published id is channel-qualified and unique', () => {
    const entries = listRegistry()
    const ids = entries.map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of entries) {
      expect(entry.id).toBe(`${entry.channel}-${entry.upstream}`)
    }
  })

  test('a local entry always names the catalog that proves its availability', () => {
    for (const entry of listRegistry()) {
      if (entry.channel === 'local') expect(entry.source).toBeDefined()
      else expect(entry.source).toBeUndefined()
    }
  })

  test('rejects an id that disagrees with its own channel prefix', () => {
    expect(() =>
      parseModelRegistry({ models: [{ ...validEntry, id: 'local-kimi-k3' }] }),
    ).toThrow(/channel prefix/)
  })

  test('rejects a duplicate id', () => {
    expect(() => parseModelRegistry({ models: [validEntry, validEntry] })).toThrow(
      /declared more than once/,
    )
  })

  // A default the upstream does not accept surfaces downstream as an opaque
  // 400, so it must fail at load time instead.
  test('rejects a default effort outside the declared efforts list', () => {
    expect(() =>
      parseModelRegistry({
        models: [
          {
            ...validEntry,
            thinking: { efforts: ['high'], default: 'low', canDisable: true },
          },
        ],
      }),
    ).toThrow(/outside its own efforts list/)
  })
})

describe('channel-qualified routing', () => {
  test('never remaps or escalates an explicitly chosen channel id', () => {
    // Bare haiku is remapped onto a cheap gemini gear; the prefixed id must not
    // be, or the request would silently bill the wrong account.
    expect(resolveModel('claude-haiku-4-5', 'summarize this').model).toBe('gemini-3.6-flash-low')
    expect(resolveModel('ccr-claude-haiku-4-5', 'think hard')).toEqual({
      model: 'ccr-claude-haiku-4-5',
      escalated: false,
    })
    expect(resolveModel('local-gemini-3.6-flash-low', 'think hard')).toEqual({
      model: 'local-gemini-3.6-flash-low',
      escalated: false,
    })
  })

  test('a bare id falls through to legacy provider selection', async () => {
    expect(await pickRegistryWireProvider({ model: 'claude-opus-5' })).toBeNull()
  })

  test('an unpublished channel-qualified id fails loudly', async () => {
    await expect(pickRegistryWireProvider({ model: 'ccr-does-not-exist' })).rejects.toThrow(
      /not published by this gateway/,
    )
    await expect(pickRegistryWireProvider({ model: 'local-kimi-k3' })).rejects.toThrow(
      /not published by this gateway/,
    )
  })
})

describe('deepseek platform channels', () => {
  let previousDeepSeek: string | undefined
  let previousDashScope: string | undefined

  beforeEach(() => {
    previousDeepSeek = process.env.DEEPSEEK_API_KEY
    previousDashScope = process.env.DASHSCOPE_API_KEY
    process.env.DEEPSEEK_API_KEY = 'test-only-official'
    process.env.DASHSCOPE_API_KEY = 'test-only-bailian'
  })

  afterEach(() => {
    if (previousDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousDeepSeek
    if (previousDashScope === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = previousDashScope
  })

  // The two platforms answer to different model ids and different credentials;
  // routing must follow the prefix, never the shared "deepseek" substring.
  test('routes each platform to its own upstream wire', async () => {
    const official = await pickRegistryWireProvider({ model: 'official-deepseek-v4-pro' })
    expect(official?.name).toBe('anthropic-passthrough')

    const bailian = await pickRegistryWireProvider({ model: 'bailian-deepseek-v4-flash-0731' })
    expect(bailian?.name).toBe('openai-compat')
  })

  test('sends the un-prefixed model id upstream', async () => {
    const bailian = await pickRegistryWireProvider({ model: 'bailian-deepseek-v4-flash-0731' })
    const prepared = await bailian!.buildRequest({
      model: 'bailian-deepseek-v4-flash-0731',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
    })
    expect(JSON.parse(prepared.body).model).toBe('deepseek-v4-flash-0731')
  })
})
