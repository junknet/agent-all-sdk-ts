import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { pickRegistryWireProvider } from '../src/index.js'
import { findRegistryEntry } from '../src/model_registry.js'

// OpenRouter channel: OpenAI-compatible endpoint at openrouter.ai. The published
// id sanitizes the upstream's '/' and ':' to '-' (see model_registry.ts
// sanitizeUpstreamForId), but the un-sanitized upstream id must still reach the
// wire unchanged, since that's the literal OpenRouter model slug + suffix.

describe('openrouter channel routing', () => {
  let previousKey: string | undefined

  beforeEach(() => {
    previousKey = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
  })

  afterEach(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = previousKey
  })

  const id = 'openrouter-deepseek-deepseek-v4-flash-20260731-nitro'

  test('registry entry decodes the sanitized id back to the real OpenRouter slug', () => {
    expect(findRegistryEntry(id)).toMatchObject({
      channel: 'openrouter',
      upstream: 'deepseek/deepseek-v4-flash-20260731:nitro',
    })
  })

  test('routes to the openai-compat provider against openrouter.ai', async () => {
    const provider = await pickRegistryWireProvider({ model: id })
    expect(provider?.name).toBe('openai-compat')

    const prepared = await provider!.buildRequest({
      model: id,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 16,
    })
    expect(prepared.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(JSON.parse(prepared.body).model).toBe('deepseek/deepseek-v4-flash-20260731:nitro')
    expect(prepared.headers.Authorization).toBe('Bearer sk-or-test')
  })

  test('an unpublished openrouter-qualified id fails loudly instead of silently falling through', async () => {
    await expect(pickRegistryWireProvider({ model: 'openrouter-does-not-exist' })).rejects.toThrow(
      /not published by this gateway/,
    )
  })
})
