import { expect, test } from 'bun:test'
import { ChatIngressAdapter, MessagesIngressAdapter } from '../src/inbox.js'

// OpenAI Chat 里一次并行工具调用 = 一条带多个 tool_calls 的 assistant + 多条独立的
// role:'tool'。Anthropic 要求这些 tool_result 全在紧随其后的**一条** user 消息里。
function chatBodyWithParallelTools(): any {
  return {
    model: 'claude-opus-5',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'audit the repo' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_a', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          { id: 'toolu_b', function: { name: 'bash', arguments: '{"command":"find ."}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_a', content: 'a-out' },
      { role: 'tool', tool_call_id: 'toolu_b', content: 'b-out' },
    ],
  }
}

function toolResultIds(msg: any): string[] {
  const content = msg?.content
  if (!Array.isArray(content)) return []
  return content.filter((b: any) => b?.type === 'tool_result').map((b: any) => b.tool_use_id)
}

test('并行工具结果合并进同一条 user 消息，且不产生占位重复', () => {
  const req = new ChatIngressAdapter().decodeRequest(chatBodyWithParallelTools()) as any

  // user(prompt) / assistant(2×tool_use) / user(2×tool_result)
  expect(req.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'user'])
  expect(toolResultIds(req.messages[2])).toEqual(['toolu_a', 'toolu_b'])

  // 上游那条硬约束：每个 tool_use_id 全局只能出现一次
  const all = req.messages.flatMap((m: any) => toolResultIds(m))
  expect(all).toEqual([...new Set(all)])

  // 占位串（客户端真漏结果时才该出现）在这里一个都不能有
  const text = JSON.stringify(req.messages)
  expect(text).not.toContain('tool result missing from client history')
})

test('客户端真漏掉某个 tool_result 时仍补占位，且只补一次', () => {
  const body = chatBodyWithParallelTools()
  body.messages = body.messages.filter((m: any) => m.tool_call_id !== 'toolu_b')
  const req = new ChatIngressAdapter().decodeRequest(body) as any

  expect(toolResultIds(req.messages[2])).toEqual(['toolu_a', 'toolu_b'])
  const placeholder = req.messages[2].content.find((b: any) => b.tool_use_id === 'toolu_b')
  expect(placeholder.content).toContain('tool result missing from client history')
})

test('Anthropic 入口：跨消息重复的 tool_result 被去重', () => {
  const req = new MessagesIngressAdapter().decodeRequest({
    model: 'claude-opus-5',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_a', name: 'bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'first' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'dup' }] },
    ],
  }) as any

  const all = req.messages.flatMap((m: any) => toolResultIds(m))
  expect(all).toEqual(['toolu_a'])
  // 去重后空掉的消息要整条删掉，不能留空 content 数组
  expect(req.messages.some((m: any) => Array.isArray(m.content) && m.content.length === 0)).toBe(false)
})
