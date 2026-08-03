import { describe, expect, test } from 'bun:test'
import { ChatIngressAdapter, MessagesIngressAdapter } from '../src/ingress.js'
import { decodeResponsesToAnthropic } from '../src/responses_api.js'
import { createAnthropicPassthroughProvider } from '../src/providers/anthropic_passthrough_provider.js'
import { buildAvailableModelCatalog, createModelsListResponse } from '../src/model_catalog.js'

// 每条断言对应一条 2026-08-03 对 api.anthropic.com 实测出来的硬约束，
// 约束清单与实测报文见 src/anthropic_constraints.ts 顶部。

function toolResultIds(msg: any): string[] {
  const content = msg?.content
  if (!Array.isArray(content)) return []
  return content.filter((b: any) => b?.type === 'tool_result').map((b: any) => b.tool_use_id)
}

function blockTypes(msg: any): string[] {
  const content = msg?.content
  if (!Array.isArray(content)) return []
  return content.map((b: any) => b?.type)
}

describe('孤儿 tool_result（上游 400 unexpected `tool_use_id` found in `tool_result` blocks）', () => {
  test('Anthropic 入口：历史被客户端截断后残留的孤儿 tool_result 必须丢掉', () => {
    const req = new MessagesIngressAdapter().decodeRequest({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        // 拥有 toolu_gone 的那条 assistant 已经被客户端压缩掉了，只剩结果
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_gone', content: 'stale' }] },
        { role: 'user', content: 'continue' },
      ],
    }) as any

    const all = req.messages.flatMap((m: any) => toolResultIds(m))
    expect(all).toEqual([])
    // 只剩真正的用户输入，且不能留下空 content 的消息
    expect(req.messages).toEqual([{ role: 'user', content: 'continue' }])
  })

  test('OpenAI Chat 入口：tool_call_id 对不上任何 tool_calls 的 role:tool 消息必须丢掉', () => {
    const req = new ChatIngressAdapter().decodeRequest({
      model: 'claude-opus-5',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'tool', tool_call_id: 'call_gone', content: 'stale' },
        { role: 'user', content: 'continue' },
      ],
    }) as any

    expect(req.messages.flatMap((m: any) => toolResultIds(m))).toEqual([])
    expect(req.messages.map((m: any) => m.role)).toEqual(['user', 'user'])
  })

  test('Responses 入口：压缩后残留的 function_call_output 必须丢掉', () => {
    const { request } = decodeResponsesToAnthropic({
      model: 'claude-opus-5',
      input: [
        { type: 'function_call_output', call_id: 'call_gone', output: 'stale' },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
    })

    expect(request.messages.flatMap((m: any) => toolResultIds(m))).toEqual([])
    expect(request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'continue' }] }])
  })
})

describe('tool_result 必须排在 user 回合最前（[text, tool_result] 上游 400）', () => {
  test('补占位时不能 push 到 user 回合末尾', () => {
    // Claude Code 形态：工具结果之后跟一段 system-reminder 文本，在同一条 user 消息里。
    // 并行调用里 toolu_b 的结果客户端没给，占位块必须插到最前而不是 text 后面。
    const req = new MessagesIngressAdapter().decodeRequest({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_a', name: 'bash', input: {} },
            { type: 'tool_use', id: 'toolu_b', name: 'bash', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_a', content: 'a-out' },
            { type: 'text', text: '<system-reminder>…</system-reminder>' },
          ],
        },
      ],
    }) as any

    expect(blockTypes(req.messages[2])).toEqual(['tool_result', 'tool_result', 'text'])
    expect(toolResultIds(req.messages[2])).toEqual(['toolu_a', 'toolu_b'])
  })

  test('真结果落在后一条 user 消息里时，被搬到紧邻位置的最前面', () => {
    const req = new MessagesIngressAdapter().decodeRequest({
      model: 'claude-opus-5',
      max_tokens: 1024,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'bash', input: {} }] },
        { role: 'user', content: 'hurry up' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'a-out' }] },
      ],
    }) as any

    expect(blockTypes(req.messages[2])).toEqual(['tool_result', 'text'])
    expect(req.messages[2].content[0].content).toBe('a-out')
    // 搬走之后原来那条只剩空 content，必须整条删掉
    expect(req.messages.length).toBe(3)
    expect(JSON.stringify(req.messages)).not.toContain('tool result missing from client history')
  })
})

describe('max_tokens 必填（上游 400 max_tokens: Field required）', () => {
  test('Responses 入口：codex 不发 max_output_tokens 时必须兜底', () => {
    // PROTOCOL_REFERENCE §11 实测的 codex 请求体顶层就没有 max_output_tokens。
    const { request } = decodeResponsesToAnthropic({
      model: 'claude-sonnet-5',
      instructions: 'You are Codex.',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      reasoning: { effort: 'medium' },
      stream: true,
      store: false,
    })
    expect(request.max_tokens).toBeGreaterThan(0)
  })

  test('Responses 入口：客户端显式给了就用客户端的', () => {
    const { request } = decodeResponsesToAnthropic({
      model: 'claude-sonnet-5',
      input: 'hi',
      max_output_tokens: 4096,
    })
    expect(request.max_tokens).toBe(4096)
  })
})

describe('内容块形状', () => {
  test('Chat 入口：空 text 块必须丢掉（上游 400 text content blocks must be non-empty）', () => {
    // OpenAI 客户端粘图常发 [{text:''},{image_url}] 这种"没配文字的图"
    const req = new ChatIngressAdapter().decodeRequest({
      model: 'claude-opus-5',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    }) as any

    expect(blockTypes(req.messages[0])).toEqual(['image'])
  })

  test('Chat 入口：无参工具必须补出 input_schema（上游 400 input_schema: Field required）', () => {
    const req = new ChatIngressAdapter().decodeRequest({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'now', description: 'current time' } }],
    }) as any

    expect(req.tools[0].input_schema).toEqual({ type: 'object', properties: {} })
  })
})

describe('thinking 与采样参数的冲突由网关自己收（是网关注入的 thinking 造成的）', () => {
  const buildBody = async (req: any, model = 'claude-opus-5'): Promise<any> => {
    const provider = createAnthropicPassthroughProvider({
      baseURL: 'https://api.anthropic.com',
      apiKey: 'sk-test',
      model,
    })
    return JSON.parse((await provider.buildRequest(req)).body)
  }

  test('thinking 开启时丢掉 temperature≠1（上游 400 temperature may only be set to 1）', async () => {
    const body = await buildBody({
      model: 'claude-opus-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    })
    expect(body.temperature).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
  })

  test('thinking 开启时丢掉 top_p<0.95（上游 400 top_p must be >= 0.95）', async () => {
    const body = await buildBody({
      model: 'claude-opus-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'hi' }],
      top_p: 0.5,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    })
    expect(body.top_p).toBeUndefined()
  })

  test('temperature=1 / 未开思考时不动客户端的采样参数', async () => {
    const kept = await buildBody({
      model: 'claude-opus-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
      top_p: 0.95,
      thinking: { type: 'enabled', budget_tokens: 1024 },
    })
    expect(kept.temperature).toBe(1)
    expect(kept.top_p).toBe(0.95)

    const noThinking = await buildBody({
      model: 'claude-opus-5',
      max_tokens: 2048,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    })
    expect(noThinking.temperature).toBe(0)
  })
})

describe('claude-fable-5 不支持显式关思考', () => {
  test('thinking:{type:disabled} 发给 fable 前必须剥掉（上游 400 not supported for this model）', async () => {
    const provider = createAnthropicPassthroughProvider({
      baseURL: 'https://api.anthropic.com',
      apiKey: 'sk-test',
      model: 'claude-fable-5',
    })
    const body = JSON.parse(
      (
        await provider.buildRequest({
          model: 'claude-fable-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'disabled' },
        })
      ).body,
    )
    expect(body.thinking).toBeUndefined()
  })

  test('其它 claude 模型的 disabled 原样保留（实测 opus-5/sonnet-5/opus-4-8 都接受）', async () => {
    const provider = createAnthropicPassthroughProvider({
      baseURL: 'https://api.anthropic.com',
      apiKey: 'sk-test',
      model: 'claude-opus-5',
    })
    const body = JSON.parse(
      (
        await provider.buildRequest({
          model: 'claude-opus-5',
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'hi' }],
          thinking: { type: 'disabled' },
        })
      ).body,
    )
    expect(body.thinking).toEqual({ type: 'disabled' })
  })

  test('模型目录不能再对外声称 fable 可关思考', () => {
    const catalog = buildAvailableModelCatalog({
      antigravity: [],
      codex: [],
      claude: [
        { id: 'claude-fable-5', name: 'Claude Fable 5' },
        { id: 'claude-opus-5', name: 'Claude Opus 5' },
      ],
    })
    const published = createModelsListResponse(catalog).data
    const fable = published.find(m => m.id === 'claude-fable-5')
    const opus = published.find(m => m.id === 'claude-opus-5')
    expect(fable?.capabilities.canDisableThinking).toBe(false)
    expect(opus?.capabilities.canDisableThinking).toBe(true)
  })
})

describe('OpenAI 档位字段不能泄漏到 Anthropic wire', () => {
  test('Messages 入口消费掉 reasoning_effort 后必须删键（上游 400 Extra inputs are not permitted）', () => {
    const req = new MessagesIngressAdapter().decodeRequest({
      model: 'claude-fable-5',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'low',
    }) as any

    expect(req.reasoning).toEqual({ mode: 'effort', effort: 'low', source: 'client' })
    expect('reasoning_effort' in req).toBe(false)
    expect('openai_reasoning_effort' in req).toBe(false)
    // `reasoning` is the gateway IR, not an OpenAI alias; the Anthropic
    // provider consumes it before serializing the upstream wire request.
    expect('reasoning' in req).toBe(true)
  })

  test('客户端已经自带 thinking 时，多余的 OpenAI 档位键同样要删掉', () => {
    const req = new MessagesIngressAdapter().decodeRequest({
      model: 'claude-fable-5',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 2_048 },
      openai_reasoning_effort: 'high',
    }) as any

    expect(req.reasoning).toEqual({ mode: 'budget', budgetTokens: 2_048, source: 'client' })
    expect('openai_reasoning_effort' in req).toBe(false)
  })
})
