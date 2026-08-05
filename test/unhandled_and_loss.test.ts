import { expect, test, describe } from 'bun:test'
import { AnthropicEventEmitter } from '../src/emitter.js'
import { createCodexProvider } from '../src/providers/codex_provider.js'
import { createAntigravityProvider } from '../src/providers/antigravity_provider.js'
import { createOpenaiCompatProvider } from '../src/providers/openai_compat_provider.js'
import { createAnthropicPassthroughProvider } from '../src/providers/anthropic_passthrough_provider.js'
import { decodeResponsesToAnthropic } from '../src/responses_api.js'

// 两类静默失败的回归覆盖，都是真实流量证实过的：
//
// 1. `unhandled` —— parseStream 是纯命令式副作用契约，每个 provider 那个 switch 的缺省
//    分支就是黑洞：没匹配上的事件被 continue 掉，循环照样走到 finish()，客户端拿到
//    「200 但空」的假成功。实测一天 126 次 context_length_exceeded 全是这么消失的。
//    同一个故障的另一半是「流结束却从没收到终止事件」，此前同样以正常收尾出去。
//
// 2. `IRLoss` —— 出口能力不齐导致的丢弃本身没得选，无声丢不行：客户端设了 max_tokens
//    却零作用、声明了 builtin 工具模型却看不见，两边对同一次请求的理解从此分叉。
//
// 本文件用的上游报文形状全部取自 PROTOCOL_REFERENCE 与 2026-08-01..04 的真实网关日志
// (<traffic-logs>)，不是编的。

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
      let event = ''
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
        if (line.startsWith('data:')) data = line.slice('data:'.length).trim()
      }
      if (event && data) events.push({ event, data: JSON.parse(data) })
    }
  }
  return events
}

function errorEvents(emitter: AnthropicEventEmitter): Array<{ event: string; data: any }> {
  return parseAnthropicEvents(emitter.drain()).filter(e => e.event === 'error')
}

// ── 改造一之 A：未知上游事件必须被记账，不能被 switch 吞掉 ──────────────

describe('unhandled: 未匹配的上游事件不再是黑洞', () => {
  test('unhandled 只记账，绝不向出站字节流写入任何东西', () => {
    // 这条锁的是本次改造的硬约束：对客户端可见行为的唯一变化是"原本静默的失败会报错"，
    // 其余 wire 输出必须逐字节不变。unhandled 一旦往 chunks 里推东西就会破坏它。
    const emitter = new AnthropicEventEmitter()
    emitter.start({ model: 'test-model' })
    const beforeUnhandled = emitter.drain().join('')

    emitter.unhandled('response.brand_new_event', { type: 'response.brand_new_event', a: 1 })
    emitter.unhandled('<unparseable>', 'not json')

    expect(emitter.drain()).toEqual([])
    expect(emitter.getUnhandledCount()).toBe(2)

    // 且不影响后续正常发流。
    emitter.pushText('hi')
    emitter.finish()
    const after = emitter.drain().join('')
    expect(beforeUnhandled).toContain('"type":"message_start"')
    expect(after).toContain('"text":"hi"')
    expect(after).toContain('"type":"message_stop"')
  })


  test('codex —— 未知事件类型被记账，已知的生命周期/心跳事件不算', async () => {
    const provider = createCodexProvider({ accessToken: 'x.fake.token' })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      streamResponse([
        // 真实流量里确实存在、且确实不携带 IR 信息的一批：不该算 unhandled。
        { type: 'response.created' },
        { type: 'response.in_progress' },
        { type: 'response.content_part.added', output_index: 0, content_index: 0 },
        { type: 'response.output_text.delta', delta: 'hi' },
        { type: 'response.output_text.done', output_index: 0, text: 'hi' },
        { type: 'response.content_part.done', output_index: 0, content_index: 0 },
        // codex 自己的心跳，文档里没有，实测日志里 12 次。
        { type: 'keepalive', sequence_number: 2 },
        // PROTOCOL_REFERENCE §5.3 列了这个事件，但本 provider 的 switch 从没接过它 ——
        // 正是 unhandled 要暴露的那类缺口。
        { type: 'response.reasoning_text.delta', delta: 'secret', content_index: 0 },
        // 上游将来新加的事件类型。
        { type: 'response.output_item.updated', output_index: 0 },
        { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
      ]),
      emitter,
    )

    expect(emitter.getUnhandledCount()).toBe(2)
  })

  test('codex —— data 段不是合法 JSON 时也要记账', async () => {
    const provider = createCodexProvider({ accessToken: 'x.fake.token' })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      new Response(
        'data: {"type":"response.created"}\n\n' +
          'data: {broken json\n\n' +
          'data: {"type":"response.completed","response":{}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      emitter,
    )

    expect(emitter.getUnhandledCount()).toBe(1)
  })

  test('codex —— 正常成功流一条 unhandled 都不该有', async () => {
    const provider = createCodexProvider({ accessToken: 'x.fake.token' })
    const emitter = new AnthropicEventEmitter()

    // PROTOCOL_REFERENCE §11 实测序列。
    await provider.parseStream(
      streamResponse([
        { type: 'response.created' },
        { type: 'response.in_progress' },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'msg_1', type: 'message', role: 'assistant' },
        },
        { type: 'response.content_part.added', output_index: 0, content_index: 0 },
        { type: 'response.output_text.delta', delta: 'hello' },
        { type: 'response.output_text.done', output_index: 0, text: 'hello' },
        { type: 'response.content_part.done', output_index: 0, content_index: 0 },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'msg_1', type: 'message', role: 'assistant' },
        },
        { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
      ]),
      emitter,
    )

    expect(emitter.getUnhandledCount()).toBe(0)
    expect(errorEvents(emitter)).toHaveLength(0)
  })

  test('antigravity —— 未知的 part 形状被记账，五种实测形状都不算', async () => {
    const provider = createAntigravityProvider({ model: 'gemini-3.6-flash-high' })
    const emitter = new AnthropicEventEmitter()

    const chunk = {
      response: {
        candidates: [
          {
            content: {
              parts: [
                // 实测存在的全部五种形状。
                { text: 'answer' },
                { text: 'pondering', thought: true },
                { text: 'signed', thoughtSignature: 'sig==' },
                { functionCall: { id: 'c1', name: 'read', args: {} }, thoughtSignature: 'sig==' },
                { functionCall: { id: 'c2', name: 'write', args: {} } },
                // 上游新加的形状(如图片输出)，此前被 for 循环无声跳过。
                { inlineData: { mimeType: 'image/png', data: 'x' } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
      },
    }

    await provider.parseStream(streamResponse([chunk]), emitter)

    expect(emitter.getUnhandledCount()).toBe(1)
  })

  test('openai-compat —— 既无 delta 又无 usage 又无 finish_reason 的块被记账', async () => {
    const provider = createOpenaiCompatProvider({
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test',
      model: 'gpt-test',
    })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      streamResponse([
        { id: 'c', object: 'chat.completion.chunk', choices: [{ delta: { content: 'hi' } }] },
        // 没人认领的形状。
        { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0 }] },
        { id: 'c', object: 'chat.completion.chunk', choices: [{ delta: {}, finish_reason: 'stop' }] },
        // include_usage 的收尾块：choices 为空 + usage，属于已处理，不算 unhandled。
        {
          id: 'c',
          object: 'chat.completion.chunk',
          choices: [],
          usage: { prompt_tokens: 4, completion_tokens: 1 },
        },
      ]),
      emitter,
    )

    expect(emitter.getUnhandledCount()).toBe(1)
  })
})

// ── 改造一之 B：流结束却没有终止事件，必须报错而不是假成功 ──────────────

describe('截断流必须显式报错，不能产出「200 但空」', () => {
  test('codex —— 没有 response.completed/failed/error 就报错', async () => {
    const provider = createCodexProvider({ accessToken: 'x.fake.token' })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      streamResponse([{ type: 'response.created' }, { type: 'response.in_progress' }]),
      emitter,
    )

    const errors = errorEvents(emitter)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.data.error.message).toContain('without a terminal event')
  })

  test('codex —— 已经收到 response.failed 时不再叠一条截断错误', async () => {
    const provider = createCodexProvider({ accessToken: 'x.fake.token' })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      streamResponse([
        { type: 'response.created' },
        {
          type: 'response.failed',
          response: {
            id: 'resp_test',
            status: 'failed',
            error: { code: 'context_length_exceeded', message: 'Your input exceeds the context window of this model.' },
          },
        },
      ]),
      emitter,
    )

    expect(errorEvents(emitter)).toHaveLength(0)
  })

  test('antigravity —— 没有 finishReason 就报错', async () => {
    const provider = createAntigravityProvider({ model: 'gemini-3.6-flash-high' })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      streamResponse([
        { response: { candidates: [{ content: { parts: [{ text: 'half a sen' }] } }] } },
      ]),
      emitter,
    )

    const errors = errorEvents(emitter)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.data.error.message).toContain('without a finishReason')
  })

  test('antigravity —— 带 finishReason 的正常流不报错', async () => {
    const provider = createAntigravityProvider({ model: 'gemini-3.6-flash-high' })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      streamResponse([
        {
          response: {
            candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 },
          },
        },
      ]),
      emitter,
    )

    expect(errorEvents(emitter)).toHaveLength(0)
  })

  test('openai-compat —— 流式没有 finish_reason 就报错', async () => {
    const provider = createOpenaiCompatProvider({
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test',
      model: 'gpt-test',
    })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      streamResponse([{ choices: [{ delta: { content: 'half a sen' } }] }]),
      emitter,
    )

    const errors = errorEvents(emitter)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.data.error.message).toContain('without a finish_reason')
  })

  test('openai-compat —— 非流式响应体不是 JSON 时报错', async () => {
    const provider = createOpenaiCompatProvider({
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test',
      model: 'gpt-test',
    })
    const emitter = new AnthropicEventEmitter()

    // 中间网关常见的 HTML 错误页，content-type 不是 event-stream。
    await provider.parseStream(
      new Response('<html><body>502 Bad Gateway</body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
      emitter,
    )

    const errors = errorEvents(emitter)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.data.error.message).toContain('not valid JSON')
  })

  test('openai-compat —— 非流式响应没有 choices 时报错', async () => {
    const provider = createOpenaiCompatProvider({
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test',
      model: 'gpt-test',
    })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      new Response(JSON.stringify({ id: 'c', object: 'chat.completion', choices: [] }), {
        headers: { 'content-type': 'application/json' },
      }),
      emitter,
    )

    const errors = errorEvents(emitter)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.data.error.message).toContain('no choices')
  })

  test('openai-compat —— 正常非流式响应不报错', async () => {
    const provider = createOpenaiCompatProvider({
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test',
      model: 'gpt-test',
    })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      new Response(
        JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 1 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
      emitter,
    )

    expect(errorEvents(emitter)).toHaveLength(0)
  })

  test('anthropic-passthrough —— 上游没发 message_stop 就报错', async () => {
    const provider = createAnthropicPassthroughProvider({
      baseURL: 'https://example.invalid',
      apiKey: 'k',
      model: 'claude-opus-5',
    })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":32}}}\n\n' +
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      emitter,
    )

    const errors = errorEvents(emitter)
    expect(errors).toHaveLength(1)
    expect(errors[0]!.data.error.message).toContain('without message_stop')
  })

  test('anthropic-passthrough —— 上游发了 message_stop 就不报错，且转发字节不变', async () => {
    const provider = createAnthropicPassthroughProvider({
      baseURL: 'https://example.invalid',
      apiKey: 'k',
      model: 'claude-opus-5',
    })
    const emitter = new AnthropicEventEmitter()

    const upstream =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":32}}}\n\n' +
      'event: ping\ndata: {"type":"ping"}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"input_tokens":32,"output_tokens":10}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n'

    await provider.parseStream(
      new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }),
      emitter,
    )

    const out = emitter.drain().join('')
    expect(out).toBe(upstream)
  })

  test('anthropic-passthrough —— 上游用 error 事件收尾也算终止，不叠第二条错误', async () => {
    const provider = createAnthropicPassthroughProvider({
      baseURL: 'https://example.invalid',
      apiKey: 'k',
      model: 'claude-opus-5',
    })
    const emitter = new AnthropicEventEmitter()

    await provider.parseStream(
      new Response(
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      emitter,
    )

    // 上游那条 error 原样转发；网关不再补自己的一条。
    expect(errorEvents(emitter)).toHaveLength(1)
  })
})

// ── 改造二：有损翻译逐条留痕 ────────────────────────────────────────

describe('IRLoss: 三处已确认的静默丢失都要留痕', () => {
  test('codex buildRequest —— max_tokens 被丢弃时记一条 loss', async () => {
    const provider = createCodexProvider({ accessToken: 'x.fake.token' })
    const prepared = await provider.buildRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 4096,
    })

    expect(prepared.losses).toHaveLength(1)
    expect(prepared.losses![0]).toMatchObject({
      stage: 'outbox',
      provider: 'codex',
      path: '$.max_tokens',
      kind: 'dropped',
    })
    expect(prepared.losses![0]!.detail).toContain('4096')
    // 出站字节流不变：max_output_tokens 依旧不许出现在 body 里。
    expect(JSON.parse(prepared.body).max_output_tokens).toBeUndefined()
  })

  test('codex buildRequest —— 客户端没给 max_tokens 就没有 loss', async () => {
    const provider = createCodexProvider({ accessToken: 'x.fake.token' })
    const prepared = await provider.buildRequest({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(prepared.losses).toHaveLength(0)
  })

  test('responses 入站 —— builtin 工具被丢弃时逐个留痕', () => {
    const { request, losses } = decodeResponsesToAnthropic({
      model: 'gemini-3.6-flash-high',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [
        { type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } },
        { type: 'local_shell' },
        { type: 'web_search' },
        { type: 'image_generation' },
      ],
    })

    // 普通 function 工具照常通过，三个 builtin 各记一条。
    expect(request.tools?.map(t => t.name)).toEqual(['read_file'])
    const builtinLosses = losses.filter(l => l.path.startsWith('$.tools[type='))
    expect(builtinLosses.map(l => l.path)).toEqual([
      '$.tools[type=local_shell]',
      '$.tools[type=web_search]',
      '$.tools[type=image_generation]',
    ])
    for (const loss of builtinLosses) {
      expect(loss.stage).toBe('inbox')
      expect(loss.kind).toBe('dropped')
      expect(loss.provider).toBeNull()
    }
  })

  test('responses 入站 —— 工具预算超限时 droppedNamespaces 行为不变且同时记 loss', () => {
    // MAX_GEMINI_TOOLS = 128。造两个各 70 个成员的 namespace：第一个进得去，第二个超预算。
    const members = (prefix: string): any[] =>
      Array.from({ length: 70 }, (_, i) => ({
        name: `${prefix}_${i}`,
        description: '',
        parameters: { type: 'object', properties: {} },
      }))

    const { losses, droppedNamespaces, namespaceTools } = decodeResponsesToAnthropic({
      model: 'gemini-3.6-flash-high',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [
        { type: 'namespace', name: 'multi_agent_v1', tools: members('agent') },
        { type: 'namespace', name: 'codex_apps_github', tools: members('gh') },
      ],
    })

    // 旧接口的对外表现必须一字不变。
    expect(droppedNamespaces).toEqual(['codex_apps_github(70)'])
    expect(namespaceTools.size).toBe(70)

    const budgetLosses = losses.filter(l => l.path.startsWith('$.tools[namespace='))
    expect(budgetLosses).toHaveLength(1)
    expect(budgetLosses[0]).toMatchObject({
      stage: 'inbox',
      provider: null,
      path: '$.tools[namespace=codex_apps_github]',
      kind: 'dropped',
    })
    expect(budgetLosses[0]!.detail).toContain('128')
  })

  test('responses 入站 —— 无法重放的 reasoning 历史与未知 item 类型也留痕', () => {
    const { losses } = decodeResponsesToAnthropic({
      model: 'gemini-3.6-flash-high',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'gAAAAA' },
        { type: 'compaction', encrypted_content: 'gAAAAA' },
      ],
    })

    expect(losses.map(l => l.path)).toEqual([
      '$.input[type=reasoning]',
      '$.input[type=compaction]',
    ])
  })

  test('responses 入站 —— 干净请求不产生任何 loss', () => {
    const { losses } = decodeResponsesToAnthropic({
      model: 'gemini-3.6-flash-high',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: {} } }],
    })

    expect(losses).toEqual([])
  })
})
