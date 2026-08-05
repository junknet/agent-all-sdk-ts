import { describe, expect, test } from 'bun:test'
import { ChatIngressAdapter } from '../src/inbox.js'
import { encodeAnthropicToResponsesSSE } from '../src/responses_api.js'
import { AnthropicEventEmitter } from '../src/emitter.js'
import {
  promptTokens,
  splitCachedFromTotalInput,
  toOpenAIChatUsage,
  toResponsesUsage,
} from '../src/usage.js'

// 下游 harness 的「上下文用到 70% 就压缩」唯一输入就是响应里的 token 用量。
// 修之前 OpenAI 的两个出口一个都不回 usage，jcode 侧 token 统计恒为 0。

function anthropicStream(usageDelta: Record<string, number>): Response {
  const body =
    'event: message_start\n' +
    `data: ${JSON.stringify({
      type: 'message_start',
      message: { id: 'msg_1', model: 'm', usage: { input_tokens: usageDelta.input_tokens ?? 0, output_tokens: 0 } },
    })}\n\n` +
    'event: content_block_start\n' +
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n` +
    'event: content_block_delta\n' +
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })}\n\n` +
    'event: content_block_stop\n' +
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n` +
    'event: message_delta\n' +
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usageDelta })}\n\n` +
    'event: message_stop\n' +
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

describe('OpenAI Chat 出口回 usage', () => {
  test('非流式：顶层带 usage，口径是 prompt/completion/total', async () => {
    const res = await new ChatIngressAdapter().encodeResponse(
      anthropicStream({ input_tokens: 100, output_tokens: 20 }),
      { model: 'm', stream: false },
      'trace',
    )
    const body: any = await res.json()
    expect(body.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })
  })

  test('非流式：缓存命中计进 prompt_tokens，并映射到 prompt_tokens_details.cached_tokens', async () => {
    // Anthropic 的 input_tokens 不含缓存，缓存那部分一样占上下文窗口，必须加回去 ——
    // 只报 input_tokens 的话 harness 会以为上下文几乎是空的，70% 阈值永远不触发。
    const res = await new ChatIngressAdapter().encodeResponse(
      anthropicStream({
        input_tokens: 500,
        output_tokens: 20,
        cache_read_input_tokens: 28_258,
        cache_creation_input_tokens: 1_709,
      }),
      { model: 'm', stream: false },
      'trace',
    )
    const body: any = await res.json()
    expect(body.usage.prompt_tokens).toBe(500 + 28_258 + 1_709)
    expect(body.usage.prompt_tokens_details).toEqual({ cached_tokens: 28_258 })
  })

  test('流式 + include_usage：DONE 之前多一个 choices:[] 的 usage chunk', async () => {
    const res = await new ChatIngressAdapter().encodeResponse(
      anthropicStream({ input_tokens: 100, output_tokens: 20 }),
      { model: 'm', stream: true, stream_options: { include_usage: true } },
      'trace',
    )
    const text = await readAll(res.body!)

    const usageIdx = text.indexOf('"usage"')
    const doneIdx = text.indexOf('[DONE]')
    expect(usageIdx).toBeGreaterThan(-1)
    expect(doneIdx).toBeGreaterThan(usageIdx) // usage 必须在 DONE 之前

    const usageChunk = text
      .split('\n')
      .filter(l => l.startsWith('data: ') && l.includes('"usage"'))
      .map(l => JSON.parse(l.slice(6)))[0]
    expect(usageChunk.choices).toEqual([])
    expect(usageChunk.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 })
  })

  test('流式未声明 include_usage：不塞 usage（无条件塞会让严格解析的客户端炸）', async () => {
    const res = await new ChatIngressAdapter().encodeResponse(
      anthropicStream({ input_tokens: 100, output_tokens: 20 }),
      { model: 'm', stream: true },
      'trace',
    )
    const text = await readAll(res.body!)
    expect(text).not.toContain('"usage"')
    expect(text).toContain('[DONE]')
  })
})

describe('OpenAI Responses 出口回 usage', () => {
  test('用 Responses 自己的 input_tokens/output_tokens 形状，不套 chat 的', async () => {
    const text = await readAll(
      encodeAnthropicToResponsesSSE(
        anthropicStream({ input_tokens: 869, output_tokens: 159, cache_read_input_tokens: 17_792 }),
        'gpt-5.6-sol',
      ),
    )
    const completed = text
      .split('\n')
      .filter(l => l.startsWith('data: ') && l.includes('response.completed'))
      .map(l => JSON.parse(l.slice(6)))[0]

    expect(completed.response.usage).toEqual({
      input_tokens: 869 + 17_792,
      output_tokens: 159,
      total_tokens: 869 + 17_792 + 159,
      input_tokens_details: { cached_tokens: 17_792 },
    })
    // 别把 chat 的字段名混进来
    expect(completed.response.usage.prompt_tokens).toBeUndefined()
  })
})

describe('四家上游的 usage 字段名都要能正确归一', () => {
  // IR 一律 Anthropic 语义：inputTokens 不含缓存。含缓存口径的上游必须先拆。
  test('anthropic-passthrough：裸转发流里的 usage 被 emitter 收下', () => {
    const em = new AnthropicEventEmitter()
    em.emitRawChunk(
      'data: {"type":"message_start","message":{"usage":{"input_tokens":32,"cache_read_input_tokens":28258,"cache_creation_input_tokens":1709}}}\n\n',
    )
    em.emitRawChunk('data: {"type":"message_delta","usage":{"input_tokens":32,"output_tokens":10}}\n\n')
    expect(em.getUsage()).toEqual({ input: 32, output: 10, cacheRead: 28258, cacheCreation: 1709 })
    expect(promptTokens({
      inputTokens: 32, outputTokens: 10, cacheReadTokens: 28258, cacheCreationTokens: 1709,
    })).toBe(29_999)
  })

  test('codex：input_tokens 含 cached，要拆出来才不双倍计数', () => {
    // PROTOCOL_REFERENCE §11 实测: input_tokens 18661 中 cached 17792
    const em = new AnthropicEventEmitter()
    const split = splitCachedFromTotalInput(18_661, 17_792)
    em.setUsage({ input: split.input, output: 159, cacheRead: split.cacheRead })
    const u = em.getUsage()
    expect(u.input).toBe(869)
    expect(u.cacheRead).toBe(17_792)
    // 换算回 OpenAI 口径要还原成 18661，不能变成 36453
    expect(toOpenAIChatUsage({
      inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheCreationTokens: 0,
    }).prompt_tokens).toBe(18_661)
  })

  test('openai-compat / DeepSeek：prompt_cache_hit_tokens 同样含在 prompt_tokens 里', () => {
    const split = splitCachedFromTotalInput(52_949, 50_000)
    expect(split).toEqual({ input: 2_949, cacheRead: 50_000 })
    expect(toResponsesUsage({
      inputTokens: 2_949, outputTokens: 7, cacheReadTokens: 50_000, cacheCreationTokens: 0,
    }).input_tokens).toBe(52_949)
  })

  test('antigravity：上游不报缓存时不硬造 cached_tokens 字段', () => {
    const split = splitCachedFromTotalInput(204_605, undefined)
    expect(split).toEqual({ input: 204_605 })
    const chat = toOpenAIChatUsage({
      inputTokens: 204_605, outputTokens: 30, cacheReadTokens: 0, cacheCreationTokens: 0,
    })
    expect(chat.prompt_tokens).toBe(204_605)
    expect('prompt_tokens_details' in chat).toBe(false)
  })
})
