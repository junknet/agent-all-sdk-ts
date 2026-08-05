/**
 * 验证 agent-ir 作为本仓库的 lib 依赖可用的最小闭环。
 *
 * 不是迁移:本仓库保留 server / 凭据 / 模型注册表,把「协议解码 → IR → 能力裁决 → writeOutboxRequest/readOutboxResponse」
 * 这一整条决策链交给 agent-ir lib。本测试只锁边界:
 *
 *  1. 从 node_modules 的 agent-ir 包能 import 出 IR 类型与注册表
 *  2. 入口解码(anthropic → IR)能跑,产出的 IRRequest 是类型完备的
 *  3. L2 准入裁决(admission)能对出口 profile 表态
 *  4. 出口 lower 能构造出上游 wire 请求(走测试用的本地 URL,不真发)
 *
 * 若 agent-ir 没装为依赖,这里 import 直接失败 —— 让"没接上 lib"在编译期就暴露。
 */
import { describe, expect, test } from 'bun:test'
import {
  IR_PROTOCOLS,
  INBOX_CODECS,
  INBOX_PATHS,
  checkOutboxSupport,
  createAnthropicOutbox,
  type IRProtocol,
} from 'agent-ir'

const TRACE = 'test-lib-close-loop'

describe('agent-ir as a library', () => {
  test('protocol registry is exhaustive over the three client protocols', () => {
    expect(IR_PROTOCOLS).toContain('anthropic_messages')
    expect(IR_PROTOCOLS).toContain('openai_responses')
    expect(IR_PROTOCOLS).toContain('openai_chat_completions')
    expect(Object.keys(INBOX_CODECS).sort()).toEqual([...IR_PROTOCOLS].sort())
    expect(INBOX_PATHS['/v1/messages']).toBe('anthropic_messages')
    expect(INBOX_PATHS['/v1/responses']).toBe('openai_responses')
    expect(INBOX_PATHS['/v1/chat/completions']).toBe('openai_chat_completions')
  })

  test('anthropic /v1/messages body decodes into a complete IRRequest', () => {
    const raw = {
      model: 'claude-opus-5',
      max_tokens: 8192,
      stream: true,
      messages: [{ role: 'user', content: 'hello from the lib test' }],
      tools: [
        {
          name: 'bash',
          description: 'Run a command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    }
    const codec = INBOX_CODECS['anthropic_messages']
    const { request } = codec.readClientRequest(raw, TRACE)
    expect(request.protocol).toBe('anthropic_messages')
    expect(request.model).toBe('claude-opus-5')
    expect(request.conversation.turns).toHaveLength(1)
    expect(request.conversation.turns[0]!.role).toBe('user')
    expect(request.conversation.toolset.tools).toHaveLength(1)
    // L1 解码出的意图有 source,区分客户端声明与网关默认
    expect(request.intent.stopping.maxOutputTokens?.value).toBe(8192)
    expect(request.requires.length).toBeGreaterThan(0)
  })

  test('admission verdict admits a request the anthropic outbox can carry', () => {
    const raw = {
      model: 'claude-opus-5',
      max_tokens: 4096,
      stream: true,
      messages: [{ role: 'user', content: 'x' }],
    }
    const { request } = INBOX_CODECS['anthropic_messages'].readClientRequest(raw, TRACE)
    const outbox = createAnthropicOutbox({
      baseUrl: 'http://localhost:1',
      apiKey: 'test-key',
      model: 'claude-opus-5',
    })
    const verdict = checkOutboxSupport(request, outbox.profile, 'anthropic')
    expect(verdict.admitted).toBe(true)
    expect(verdict.unsupported).toHaveLength(0)
  })

  test('outbox lower builds an anthropic wire request without hitting the network', async () => {
    const raw = {
      model: 'claude-opus-5',
      max_tokens: 4096,
      stream: true,
      messages: [{ role: 'user', content: 'say hi' }],
    }
    const { request } = INBOX_CODECS['anthropic_messages'].readClientRequest(raw, TRACE)
    const outbox = createAnthropicOutbox({
      baseUrl: 'http://localhost:1',
      apiKey: 'test-key',
      model: 'claude-opus-5',
    })
    const lowered = await outbox.writeOutboxRequest(request)
    expect(lowered.ok).toBe(true)
    if (!lowered.ok) return
    expect(lowered.wire.url).toContain('/v1/messages')
    const body = JSON.parse(lowered.wire.body) as Record<string, unknown>
    expect(body.model).toBe('claude-opus-5')
    expect(body.messages).toHaveLength(1)
    expect(body.max_tokens).toBe(4096)
    // 有损翻译(如果有)必须逐条带在 result 上,不能静默
    expect(Array.isArray(lowered.losses)).toBe(true)
  })
})
