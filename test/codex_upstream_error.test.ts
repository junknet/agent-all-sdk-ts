import { test, expect } from 'bun:test'
import { AnthropicEventEmitter } from '../src/emitter.js'
import { createCodexProvider } from '../src/providers/codex_provider.js'

// Regression coverage for a real production incident: Codex/ChatGPT rejects requests
// mid-stream (HTTP 200, SSE body) instead of via HTTP status when the accumulated
// session context exceeds the model's window. Before the fix, parseStream's switch had
// no case for either shape the backend actually sends, so the loop silently skipped the
// error and finished with zero content/tool calls and stop_reason 'end_turn' — a
// 200-shaped response that LOOKS successful but is empty. The calling harness has no way
// to distinguish "nothing to say" from "upstream rejected this" and retries blindly until
// exhausting its own retry cap, surfacing only a generic "Assistant returned empty stop
// after retry cap" with zero indication of the real cause.
//
// Verified live: grep-ing one day of gateway devlog traffic
// (<traffic-logs>/gateway-dev-20260801.ndjson) found 126
// occurrences of context_length_exceeded, every one of them silently swallowed.

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function streamResponse(chunks: unknown[]): Response {
  return new Response(chunks.map(sseData).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function parseAnthropicEvents(chunks: string[]): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = []
  for (const chunk of chunks) {
    for (const block of chunk.split('\n\n')) {
      if (!block.trim()) continue
      const lines = block.split('\n')
      const eventLine = lines.find(l => l.startsWith('event: '))
      const dataLine = lines.find(l => l.startsWith('data: '))
      if (!eventLine || !dataLine) continue
      events.push({ event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) })
    }
  }
  return events
}

function collectText(events: Array<{ event: string; data: any }>): string {
  return events
    .filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta')
    .map(e => e.data.delta.text as string)
    .join('')
}

// Exact shape captured live from chatgpt.com/backend-api/codex/responses.
const REAL_CONTEXT_LENGTH_ERROR_EVENT = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    code: 'context_length_exceeded',
    message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
    param: 'input',
  },
  sequence_number: 2,
}

const REAL_RESPONSE_FAILED_EVENT = {
  type: 'response.failed',
  response: {
    id: 'resp_test',
    object: 'response',
    status: 'failed',
    error: {
      code: 'context_length_exceeded',
      message: 'Your input exceeds the context window of this model. Please adjust your input and try again.',
    },
  },
}

test('codex parseStream surfaces a mid-stream `error` event as visible text, not a silent empty turn', async () => {
  const provider = createCodexProvider({ accessToken: 'x.fake.token' })
  const emitter = new AnthropicEventEmitter()

  await provider.parseStream(
    streamResponse([
      { type: 'response.created' },
      { type: 'response.in_progress' },
      REAL_CONTEXT_LENGTH_ERROR_EVENT,
      REAL_RESPONSE_FAILED_EVENT,
    ]),
    emitter,
  )

  const events = parseAnthropicEvents(emitter.drain())
  const text = collectText(events)

  expect(text).toContain('context_length_exceeded')
  expect(text).toContain('exceeds the context window')
  // Both `error` and `response.failed` fired for the SAME rejection (verified live) — must
  // not double-surface the same message.
  expect(text.match(/context_length_exceeded/g)?.length).toBe(1)

  const stopReasonEvent = events.find(e => e.event === 'message_delta')
  expect(stopReasonEvent?.data.delta.stop_reason).toBe('end_turn')

  // Must not be marked unusable: this is a deterministic rejection (the payload really is
  // too big), so the adapter's retry-on-unusable path would just burn 3 more attempts for
  // the identical result. Surfacing it as text is the terminal, correct outcome.
  expect(emitter.isUnusable()).toBe(false)
  expect(emitter.hasProducedContent()).toBe(true)
})

test('codex parseStream surfaces `response.failed` alone (no top-level `error` event) too', async () => {
  const provider = createCodexProvider({ accessToken: 'x.fake.token' })
  const emitter = new AnthropicEventEmitter()

  await provider.parseStream(
    streamResponse([{ type: 'response.created' }, REAL_RESPONSE_FAILED_EVENT]),
    emitter,
  )

  const text = collectText(parseAnthropicEvents(emitter.drain()))
  expect(text).toContain('context_length_exceeded')
  expect(emitter.hasProducedContent()).toBe(true)
})

test('codex parseStream normal success path is unaffected by the error handling addition', async () => {
  const provider = createCodexProvider({ accessToken: 'x.fake.token' })
  const emitter = new AnthropicEventEmitter()

  await provider.parseStream(
    streamResponse([
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'hello world' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ]),
    emitter,
  )

  const text = collectText(parseAnthropicEvents(emitter.drain()))
  expect(text).toBe('hello world')
})
