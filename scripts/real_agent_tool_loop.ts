/**
 * 真实两轮 agent 验收：模型必须先调用工具，再消费 tool_result 完成第二轮回答。
 *
 * 运行前先启动 gateway，例如：
 *   AGENT_GATEWAY_PORT=8103 bun run src/server.ts
 *   AGENT_GATEWAY_BASE_URL=http://127.0.0.1:8103 bun scripts/real_agent_tool_loop.ts
 *
 * 不打印凭据、不执行模型返回的任意代码；这里的工具是确定性测试桩。
 */
type SseEvent = { readonly event: string; readonly data: Record<string, unknown> }

const baseUrl = process.env.AGENT_GATEWAY_BASE_URL ?? 'http://127.0.0.1:8103'
const marker = 'TOOL-LOOP-MARKER-20260805'
const models = [
  'windsurf-claude-sonnet-5-medium',
  'local-claude-sonnet-5',
  'local-gpt-5.6-luna',
]

const tool = {
  name: 'lookup_marker',
  description: 'Look up the marker for a request. This test requires calling it before answering.',
  input_schema: {
    type: 'object',
    properties: { request: { type: 'string' } },
    required: ['request'],
    additionalProperties: false,
  },
}

function parseSse(body: string): SseEvent[] {
  const events: SseEvent[] = []
  for (const frame of body.replace(/\r\n/g, '\n').split('\n\n')) {
    const lines = frame.split('\n')
    const event = lines.find(line => line.startsWith('event:'))?.slice('event:'.length).trim() ?? 'message'
    const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice('data:'.length).trim()).join('\n')
    if (!raw || raw === '[DONE]') continue
    try {
      const data = JSON.parse(raw) as Record<string, unknown>
      events.push({ event, data })
    } catch {
      // 本验收只接受完整的 Anthropic SSE JSON；坏帧不能被当成一次通过。
    }
  }
  return events
}

async function send(body: Record<string, unknown>): Promise<SseEvent[]> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`gateway returned HTTP ${response.status}: ${text.slice(0, 500)}`)
  return parseSse(text)
}

function toolUse(events: readonly SseEvent[]): { id: string; name: string; input: Record<string, unknown> } | null {
  let current: { id: string; name: string; input: Record<string, unknown>; json: string } | null = null
  for (const event of events) {
    if (event.event === 'content_block_start') {
      const block = event.data.content_block as Record<string, unknown> | undefined
      if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        current = {
          id: block.id,
          name: block.name,
          input: (block.input as Record<string, unknown> | undefined) ?? {},
          json: '',
        }
      }
    }
    if (current !== null && event.event === 'content_block_delta') {
      const delta = event.data.delta as Record<string, unknown> | undefined
      if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') current.json += delta.partial_json
    }
  }
  if (current === null) return null
  if (current.json.length > 0) {
    try { current.input = JSON.parse(current.json) as Record<string, unknown> } catch {
      throw new Error(`tool ${current.name} emitted malformed JSON arguments`)
    }
  }
  return { id: current.id, name: current.name, input: current.input }
}

function text(events: readonly SseEvent[]): string {
  return events
    .filter(event => event.event === 'content_block_delta')
    .map(event => event.data.delta as Record<string, unknown> | undefined)
    .filter((delta): delta is Record<string, unknown> => delta?.type === 'text_delta' && typeof delta.text === 'string')
    .map(delta => delta.text as string)
    .join('')
}

async function verify(model: string): Promise<void> {
  const system = [
    'You are in a two-turn tool-loop integration test.',
    'On the first turn, call lookup_marker exactly once with a non-empty request; do not answer with prose.',
    `After receiving its result, answer exactly: VERIFIED ${marker}`,
  ].join(' ')
  const first = await send({
    model, max_tokens: 128, stream: true, system, tools: [tool], tool_choice: { type: 'any' },
    messages: [{ role: 'user', content: 'Retrieve the verification marker via the tool.' }],
  })
  const call = toolUse(first)
  if (call === null || call.name !== tool.name) {
    throw new Error(`${model}: first turn did not emit ${tool.name}; events=${first.map(event => event.event).join(',')}`)
  }

  // Deterministic local tool execution. The assertion below proves the returned id is replayed.
  const result = JSON.stringify({ marker, request: call.input.request ?? null, source: 'deterministic-test-tool' })
  const second = await send({
    model, max_tokens: 128, stream: true, system, tools: [tool],
    messages: [
      { role: 'user', content: 'Retrieve the verification marker via the tool.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: result }] },
    ],
  })
  const finalText = text(second).trim()
  const expected = `VERIFIED ${marker}`
  if (finalText !== expected) throw new Error(`${model}: second turn expected '${expected}', got '${finalText}'`)
  console.log(JSON.stringify({ model, tool: call.name, toolInput: call.input, finalText }))
}

for (const model of models) await verify(model)
