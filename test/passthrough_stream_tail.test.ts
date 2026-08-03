import { describe, expect, test } from 'bun:test'
import { AnthropicEventEmitter } from '../src/emitter.js'

// anthropic-passthrough 的 parseStream 是裸转发(emitRawChunk)，收尾由 createWireAdapter
// 统一调 finish() 兜底。上游已经自带 message_delta+message_stop 时再补一份，等于在一条
// message 里发两个 message_stop，且后补的那条把真实 stop_reason 覆盖成 end_turn。
// 实测证据(2026-08-02 流量日志)：上游 stop_reason:"max_tokens" → 下游最后看到 end_turn。

function upstreamTail(stopReason: string): string {
  return (
    'event: message_delta\n' +
    `data: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"input_tokens":32,"output_tokens":10}}\n\n` +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  )
}

describe('裸转发流的收尾不能被重复补一遍', () => {
  test('上游已发 message_stop 时，finish() 不再追加第二份收尾', () => {
    const em = new AnthropicEventEmitter()
    em.emitRawChunk('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":32}}}\n\n')
    em.emitRawChunk(upstreamTail('max_tokens'))
    em.finish()

    const out = em.drain().join('')
    expect(out.split('"type":"message_stop"').length - 1).toBe(1)
    expect(out).toContain('"stop_reason":"max_tokens"')
    expect(out).not.toContain('"stop_reason":"end_turn"')
  })

  test('tool_use 收尾同样不会被改写成 end_turn', () => {
    const em = new AnthropicEventEmitter()
    em.emitRawChunk(upstreamTail('tool_use'))
    em.finish()

    const out = em.drain().join('')
    expect(out).toContain('"stop_reason":"tool_use"')
    expect(out).not.toContain('"stop_reason":"end_turn"')
  })

  test('上游流被掐断(没有 message_stop)时，兜底收尾必须照发', () => {
    const em = new AnthropicEventEmitter()
    em.emitRawChunk('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n')
    em.finish()

    const out = em.drain().join('')
    expect(out.split('"type":"message_stop"').length - 1).toBe(1)
    expect(out).toContain('"stop_reason":"end_turn"')
  })
})
