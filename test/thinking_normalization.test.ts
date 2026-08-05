import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ChatIngressAdapter } from '../src/inbox.js'
import { MessagesIngressAdapter } from '../src/inbox.js'
import { decodeResponsesToAnthropic } from '../src/responses_api.js'
import { parseAnthropicThinking, parseReasoningEffort, toAnthropicThinking } from '../src/thinking.js'
import { createAnthropicPassthroughProvider } from '../src/providers/anthropic_passthrough_provider.js'
import { createCodexResponsesOutboxProvider } from '../src/providers/codex_responses_outbox.js'
import { createOpenaiCompatProvider } from '../src/providers/openai_compat_provider.js'

let previousDefaultEffort: string | undefined

beforeEach(() => {
  previousDefaultEffort = process.env.AGENT_GATEWAY_DEFAULT_EFFORT
  process.env.AGENT_GATEWAY_DEFAULT_EFFORT = 'high'
})

afterEach(() => {
  if (previousDefaultEffort === undefined) delete process.env.AGENT_GATEWAY_DEFAULT_EFFORT
  else process.env.AGENT_GATEWAY_DEFAULT_EFFORT = previousDefaultEffort
})

describe('reasoning effort normalization', () => {
  test('keeps effort semantic in the IR until the Anthropic outbox maps it', () => {
    const intent = parseReasoningEffort('max')
    expect(intent).toEqual({ mode: 'effort', effort: 'max', source: 'client' })
    expect(toAnthropicThinking(intent)).toEqual({ type: 'enabled', budget_tokens: 32_000 })
  })

  test('keeps Anthropic’s exact numeric budget in the IR', () => {
    expect(parseAnthropicThinking({ type: 'enabled', budget_tokens: 8_192 })).toEqual({
      mode: 'budget', budgetTokens: 8_192, source: 'client',
    })
  })

  test('explicit Chat none disables thinking instead of falling through to the default', () => {
    const request = new ChatIngressAdapter().decodeRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'none',
    })
    expect(request.reasoning).toEqual({ mode: 'disabled', source: 'client' })
  })

  test('explicit Responses none is preserved as a disabled IR state', () => {
    const { request } = decodeResponsesToAnthropic({
      model: 'gpt-5.6-sol',
      input: 'hello',
      reasoning: { effort: 'none' },
    })
    expect(request.reasoning).toEqual({ mode: 'disabled', source: 'client' })
  })

  test('invalid explicit effort fails with context instead of silently changing intent', () => {
    expect(() => parseReasoningEffort('turbo')).toThrow(/Unsupported reasoning effort 'turbo'/)
  })

  test('explicit auto is preserved and never replaced with the gateway default', () => {
    expect(new ChatIngressAdapter().decodeRequest({ messages: [], reasoning_effort: 'auto' }).reasoning)
      .toEqual({ mode: 'auto', source: 'client' })
  })

  test('all three inbox protocols mark an injected default as gateway-owned', () => {
    const messages = new MessagesIngressAdapter().decodeRequest({ messages: [] })
    const chat = new ChatIngressAdapter().decodeRequest({ messages: [] })
    const responses = decodeResponsesToAnthropic({ input: [] }).request
    for (const request of [messages, chat, responses]) {
      expect(request.reasoning).toEqual({ mode: 'effort', effort: 'high', source: 'gateway-default' })
    }
  })

  test('Anthropic outbox consumes IR and preserves a client budget exactly', async () => {
    const provider = createAnthropicPassthroughProvider({ baseURL: 'https://example.invalid', apiKey: 'key' })
    const body = JSON.parse((await provider.buildRequest({
      model: 'claude-test', messages: [], max_tokens: 16,
      reasoning: { mode: 'budget', budgetTokens: 8_192, source: 'client' },
    })).body)
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8_192 })
    expect(body.reasoning).toBeUndefined()
  })

  test('tier exits as a tier on Codex and OpenAI-compatible wires', async () => {
    const request = { messages: [], reasoning: { mode: 'effort' as const, effort: 'max' as const, source: 'client' as const } }
    const codex = JSON.parse((await createCodexResponsesOutboxProvider({ accessToken: 'x.fake.token' }).buildRequest(request)).body)
    const compat = JSON.parse((await createOpenaiCompatProvider({ baseURL: 'https://example.invalid/v1', apiKey: 'key', model: 'test' }).buildRequest(request)).body)
    expect(codex.reasoning).toMatchObject({ effort: 'high' })
    expect(compat.reasoning_effort).toBe('high')
    expect(compat.reasoning).toBeUndefined()
  })
})
