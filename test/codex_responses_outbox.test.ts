import { expect, test } from 'bun:test'
import { createCodexResponsesOutboxProvider } from '../src/providers/codex_responses_outbox.js'

test('local Codex 使用 agent-ir WebSocket Outbox：默认 priority、丢弃不被端点接受的输出上限，并交由单轨 Inbox 回写', async () => {
  const provider = createCodexResponsesOutboxProvider({ accessToken: 'x.fake.token', model: 'gpt-5.6-terra' })
  const prepared = await provider.buildRequest({
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: true,
  })
  const body = JSON.parse(prepared.body)
  expect(body.service_tier).toBe('priority')
  expect(body.max_output_tokens).toBeUndefined()
  expect(body.type).toBe('response.create')
  expect(prepared.losses).toContainEqual(expect.objectContaining({ path: '$.intent.stopping.maxOutputTokens' }))
  expect(prepared.createAnthropicInboxResponse).toBeDefined()
  expect(prepared.url).toStartWith('wss://')
  expect(prepared.headers['openai-beta']).toBe('responses_websockets=2026-02-06')
})
