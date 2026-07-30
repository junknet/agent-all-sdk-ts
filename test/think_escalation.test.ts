import { expect, test, describe } from 'bun:test'
import { resolveModel, latestUserInput } from '../src/index.js'

// The 「思考」 escalation must be a per-input STATE MACHINE: a human input with 「思考」 lifts
// the gear and HOLDS across that turn's whole agent tool-loop; the NEXT human input without
// 「思考」 drops it back. It must NOT be sticky-forever (one 「思考」 anywhere in history keeping
// every later request escalated). These tests pin that contract across all three protocols.

const BASE = 'gemini-3.5-flash-low'         // a lower flash gear → eligible for escalation
const HIGH = 'gemini-3.6-flash-high'  // 与 index.ts HIGH_GEAR 对齐(2026-07-30 升到 3.6)

const resolvedFor = (body: any) => resolveModel(BASE, latestUserInput(body))

describe('「思考」 escalation is a per-input state machine, not sticky history', () => {
  test('anthropic /v1/messages: human input with 「思考」 escalates', () => {
    const body = { messages: [{ role: 'user', content: '思考 一下这个架构' }] }
    expect(resolvedFor(body)).toEqual({ model: HIGH, escalated: true })
  })

  test('anthropic: escalation HOLDS through the tool-loop (last user msg is a tool_result)', () => {
    // Continuation request: no new human turn, only assistant tool_use + user tool_result.
    const body = {
      messages: [
        { role: 'user', content: '思考 一下这个架构' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
      ],
    }
    // latest HUMAN turn is still the 「思考」 one → stays escalated across the loop
    expect(latestUserInput(body)).toBe('思考 一下这个架构')
    expect(resolvedFor(body)).toEqual({ model: HIGH, escalated: true })
  })

  test('anthropic: NEXT human input without 「思考」 drops back to base (not sticky)', () => {
    const body = {
      messages: [
        { role: 'user', content: '思考 一下这个架构' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: '继续改下一个文件' }, // new human turn, no 「思考」
      ],
    }
    expect(latestUserInput(body)).toBe('继续改下一个文件')
    expect(resolvedFor(body)).toEqual({ model: BASE, escalated: false })
  })

  test('openai /v1/chat: tool role is not human input; latest user turn decides', () => {
    const body = {
      messages: [
        { role: 'user', content: 'think hard about this' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    }
    expect(latestUserInput(body)).toBe('think hard about this')
    expect(resolvedFor(body)).toEqual({ model: HIGH, escalated: true })
  })

  test('codex /v1/responses: latest message item decides; function_call_output skipped', () => {
    const holds = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '深思 这个 bug' }] },
        { type: 'function_call', call_id: 'c1', name: 'x', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'stack trace' },
      ],
    }
    expect(latestUserInput(holds)).toBe('深思 这个 bug')
    expect(resolvedFor(holds)).toEqual({ model: HIGH, escalated: true })

    const next = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '深思 这个 bug' }] },
        { type: 'function_call_output', call_id: 'c1', output: 'stack trace' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '换个方案' }] },
      ],
    }
    expect(latestUserInput(next)).toBe('换个方案')
    expect(resolvedFor(next)).toEqual({ model: BASE, escalated: false })
  })

  test('image-only follow-up turn (no text) does not re-trigger a past 「思考」', () => {
    const body = {
      messages: [
        { role: 'user', content: '思考 看看' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }] },
      ],
    }
    // newest human turn is the image-only one → empty text → no escalation
    expect(latestUserInput(body)).toBe('')
    expect(resolvedFor(body)).toEqual({ model: BASE, escalated: false })
  })
})
