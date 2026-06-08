import { expect, test } from 'bun:test'
import { AnthropicEventEmitter } from '../src/emitter.js'
import { createAntigravityProvider } from '../src/providers/antigravity_provider.js'

// Gemini ties cross-turn reasoning to a per-functionCall `thoughtSignature`. It cannot survive
// the codex /v1/responses round-trip (no wire field carries it), so the gateway caches it by
// call_id and re-attaches it on replay. Without this, every replayed call carried the bypass
// placeholder `skip_thought_signature_validator` → gemini lost its reasoning thread → the agent
// looped (re-planning, MALFORMED_FUNCTION_CALL, 400 INVALID_ARGUMENT). Lockstep: capture → replay.

function geminiStream(parts: unknown[], finishReason = 'STOP'): Response {
  const payload = { response: { candidates: [{ content: { parts }, finishReason }] } }
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function functionCallPart(body: string, name: string): any {
  const parsed = JSON.parse(body)
  const parts = parsed.request.contents.flatMap((c: any) => c.parts ?? [])
  return parts.find((p: any) => p.functionCall?.name === name)
}

test('gemini thoughtSignature survives the codex round-trip via the call_id cache', async () => {
  const provider = createAntigravityProvider({ model: 'gemini-3-flash-agent' })
  const callId = 'fc_sigtest_round_001'
  const realSig = 'EjQKMgEM_REAL_SIGNATURE_xyz=='

  // Round 1 — gemini emits the functionCall WITH its real signature → gateway must capture it.
  const emitter = new AnthropicEventEmitter()
  await provider.parseStream(
    geminiStream([
      {
        functionCall: { id: callId, name: 'write_stdin', args: { session_id: 75921 } },
        thoughtSignature: realSig,
      },
    ]),
    emitter,
  )
  expect(emitter.getToolUseCount()).toBe(1) // sanity: the tool call was parsed

  // Round 2 — codex replays that tool_use (no signature on the wire) → gateway re-attaches REAL sig.
  const prepared = await provider.buildRequest({
    model: 'gemini-3-flash-agent',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'write_stdin', input: { session_id: 75921 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'ok' }] },
    ],
  })
  const fc = functionCallPart(prepared.body, 'write_stdin')
  expect(fc).toBeDefined()
  expect(fc.thoughtSignature).toBe(realSig)
  expect(fc.thoughtSignature).not.toBe('skip_thought_signature_validator')
})

test('a never-seen call_id still falls back to the bypass placeholder (no false signature)', async () => {
  const provider = createAntigravityProvider({ model: 'gemini-3-flash-agent' })
  const prepared = await provider.buildRequest({
    model: 'gemini-3-flash-agent',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'fc_never_seen_zzz', name: 'exec_command', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc_never_seen_zzz', content: 'ok' }] },
    ],
  })
  const fc = functionCallPart(prepared.body, 'exec_command')
  expect(fc.thoughtSignature).toBe('skip_thought_signature_validator')
})
