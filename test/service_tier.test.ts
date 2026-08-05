import { describe, expect, test } from 'bun:test'
import { ChatIngressAdapter, MessagesIngressAdapter } from '../src/inbox.js'
import { createAnthropicPassthroughProvider } from '../src/providers/anthropic_passthrough_provider.js'
import { createAntigravityProvider } from '../src/providers/antigravity_provider.js'
import { createCodexResponsesOutboxProvider } from '../src/providers/codex_responses_outbox.js'
import { createOpenaiCompatProvider } from '../src/providers/openai_compat_provider.js'
import { decodeResponsesToAnthropic } from '../src/responses_api.js'

const priority = { tier: 'priority' as const, source: 'client' as const }

describe('service tier normalization', () => {
  test('Responses, Chat, and Messages inputs share one priority IR without changing reasoning', () => {
    const responses = decodeResponsesToAnthropic({
      input: 'hello',
      service_tier: 'priority',
      reasoning: { effort: 'low' },
    }).request
    const chat = new ChatIngressAdapter().decodeRequest({
      messages: [],
      service_tier: 'priority',
      reasoning_effort: 'high',
    })
    const messages = new MessagesIngressAdapter().decodeRequest({
      messages: [],
      speed: 'fast',
      thinking: { type: 'enabled', budget_tokens: 2_048 },
    })

    expect(responses.serviceTier).toEqual(priority)
    expect(responses.reasoning).toEqual({ mode: 'effort', effort: 'low', source: 'client' })
    expect(chat.serviceTier).toEqual(priority)
    expect(chat.reasoning).toEqual({ mode: 'effort', effort: 'high', source: 'client' })
    expect(messages.serviceTier).toEqual(priority)
    expect(messages.reasoning).toEqual({ mode: 'budget', budgetTokens: 2_048, source: 'client' })
    expect('speed' in messages).toBe(false)
    expect('service_tier' in messages).toBe(false)
  })

  test('priority maps to each supported wire spelling without leaking the IR', async () => {
    const request = {
      messages: [],
      max_tokens: 16,
      serviceTier: priority,
      reasoning: { mode: 'effort' as const, effort: 'high' as const, source: 'client' as const },
    }
    const codex = JSON.parse((await createCodexResponsesOutboxProvider({ accessToken: 'x.fake.token' }).buildRequest(request)).body)
    const compat = JSON.parse((await createOpenaiCompatProvider({
      baseURL: 'https://example.invalid/v1', apiKey: 'key', model: 'test',
    }).buildRequest(request)).body)
    const anthropic = JSON.parse((await createAnthropicPassthroughProvider({
      baseURL: 'https://example.invalid', apiKey: 'key', model: 'claude-test',
    }).buildRequest(request)).body)

    expect(codex.service_tier).toBe('priority')
    expect(codex.speed).toBeUndefined()
    expect(codex.serviceTier).toBeUndefined()
    expect(compat.service_tier).toBe('priority')
    expect(compat.speed).toBeUndefined()
    expect(compat.serviceTier).toBeUndefined()
    expect(anthropic.speed).toBe('fast')
    expect(anthropic.service_tier).toBeUndefined()
    expect(anthropic.serviceTier).toBeUndefined()
    expect(anthropic.reasoning).toBeUndefined()
  })

  test('unsupported tier values fail at inbox instead of becoming an invented wire field', () => {
    expect(() => decodeResponsesToAnthropic({ input: 'hello', service_tier: 'flex' }))
      .toThrow(/Unsupported service tier 'flex'/)
    expect(() => new MessagesIngressAdapter().decodeRequest({ messages: [], speed: 'instant' }))
      .toThrow(/Unsupported Anthropic speed 'instant'/)
  })

  test('unsupported providers do not receive either the canonical or wire service-tier fields', async () => {
    const body = JSON.parse((await createAntigravityProvider({ model: 'gemini-3-flash' }).buildRequest({
      messages: [], max_tokens: 16, serviceTier: priority,
    })).body)
    expect(JSON.stringify(body)).not.toContain('serviceTier')
    expect(JSON.stringify(body)).not.toContain('service_tier')
    expect(JSON.stringify(body)).not.toContain('"speed"')
  })
})
