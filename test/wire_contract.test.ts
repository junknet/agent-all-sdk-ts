import { expect, test } from 'bun:test'
import { AnthropicEventEmitter } from '../src/emitter.js'
import { createCodexProvider } from '../src/providers/codex_provider.js'
import { createOpenaiCompatProvider } from '../src/providers/openai_compat_provider.js'
import { toolResultToResponse } from '../src/providers/antigravity_provider.js'
import { createAntigravityProvider } from '../src/providers/antigravity_provider.js'
import { pickWireProvider } from '../src/index.js'
import { createCodexProvider } from '../src/providers/codex_provider.js'

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

function collectToolBlocks(events: Array<{ event: string; data: any }>): Array<{
  id: string
  name: string
  partialJson: string
}> {
  const tools: Array<{ id: string; name: string; partialJson: string }> = []
  let current: { id: string; name: string; partialJson: string } | null = null

  for (const event of events) {
    if (
      event.event === 'content_block_start' &&
      event.data.content_block?.type === 'tool_use'
    ) {
      current = {
        id: event.data.content_block.id,
        name: event.data.content_block.name,
        partialJson: '',
      }
      tools.push(current)
      continue
    }
    if (
      current &&
      event.event === 'content_block_delta' &&
      event.data.delta?.type === 'input_json_delta'
    ) {
      current.partialJson += event.data.delta.partial_json
    }
    if (event.event === 'content_block_stop') current = null
  }

  return tools
}

test('openai-compat buffers interleaved streaming tool calls by index', async () => {
  const provider = createOpenaiCompatProvider({
    baseURL: 'https://example.invalid/v1',
    apiKey: 'test',
    model: 'gpt-test',
  })
  const emitter = new AnthropicEventEmitter()

  await provider.parseStream(
    streamResponse([
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_first', function: { name: 'first', arguments: '{"a"' } },
              { index: 1, id: 'call_second', function: { name: 'second', arguments: '{"b"' } },
            ],
          },
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: ':1}' } },
              { index: 1, function: { arguments: ':2}' } },
            ],
          },
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]),
    emitter,
  )

  const tools = collectToolBlocks(parseAnthropicEvents(emitter.drain()))
  expect(tools).toEqual([
    { id: 'call_first', name: 'first', partialJson: '{"a":1}' },
    { id: 'call_second', name: 'second', partialJson: '{"b":2}' },
  ])
})

test('codex responses buffers interleaved function call argument deltas by item id', async () => {
  const provider = createCodexProvider({ accessToken: 'x.fake.token' })
  const emitter = new AnthropicEventEmitter()

  await provider.parseStream(
    streamResponse([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc_first', type: 'function_call', call_id: 'call_first', name: 'first' },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'fc_second', type: 'function_call', call_id: 'call_second', name: 'second' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_first', delta: '{"a"' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_second', delta: '{"b"' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_first', delta: ':1}' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_second', delta: ':2}' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'fc_first', type: 'function_call', call_id: 'call_first', name: 'first' },
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: { id: 'fc_second', type: 'function_call', call_id: 'call_second', name: 'second' },
      },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2 } } },
    ]),
    emitter,
  )

  const tools = collectToolBlocks(parseAnthropicEvents(emitter.drain()))
  expect(tools).toEqual([
    { id: 'call_first', name: 'first', partialJson: '{"a":1}' },
    { id: 'call_second', name: 'second', partialJson: '{"b":2}' },
  ])
})

test('openai-compat translates user message images to content array', async () => {
  const provider = createOpenaiCompatProvider({
    baseURL: 'https://example.invalid/v1',
    apiKey: 'test',
    model: 'gpt-test',
  })
  const req = await provider.buildRequest({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'fake-base64' },
          },
        ],
      },
    ],
  })
  const body = JSON.parse(req.body)
  expect(body.messages).toEqual([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,fake-base64' },
        },
      ],
    },
  ])
})

test('openai-compat uses x-api-key when the compatible endpoint requires it', async () => {
  const provider = createOpenaiCompatProvider({
    baseURL: 'https://example.invalid/v1',
    apiKey: 'test-key',
    model: 'kimi-k3',
    authScheme: 'x-api-key',
  })

  const request = await provider.buildRequest({
    messages: [{ role: 'user', content: 'hello' }],
  })

  expect(request.headers).toEqual({
    'Content-Type': 'application/json',
    'x-api-key': 'test-key',
  })
})

test('responses compatibility provider preserves the published model and x-api-key auth', async () => {
  const provider = createCodexProvider({
    responsesBaseURL: 'https://example.invalid/v1',
    apiKey: 'test-key',
    model: 'gpt-5-4',
    authScheme: 'x-api-key',
  })

  const request = await provider.buildRequest({
    model: 'gpt-5-4',
    messages: [{ role: 'user', content: 'hello' }],
  })

  expect(request.url).toBe('https://example.invalid/v1/responses')
  expect(request.headers).toEqual({
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'x-api-key': 'test-key',
  })
  expect(JSON.parse(request.body)).toMatchObject({
    model: 'gpt-5-4',
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    }],
  })
})

test('forced compatible multi-model mode preserves the selected model', async () => {
  const names = [
    'FORCE_OPENAI_COMPAT',
    'FORCE_OPENAI_COMPAT_PRESERVE_REQUESTED_MODEL',
    'OPENAI_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENAI_COMPAT_MODEL',
  ] as const
  const previous = new Map(names.map(name => [name, process.env[name]]))
  try {
    process.env.FORCE_OPENAI_COMPAT = '1'
    process.env.FORCE_OPENAI_COMPAT_PRESERVE_REQUESTED_MODEL = '1'
    process.env.OPENAI_BASE_URL = 'https://example.invalid/v1'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_MODEL = 'unrelated-default'
    process.env.OPENAI_COMPAT_MODEL = 'another-unrelated-default'

    const provider = pickWireProvider({ model: 'glm-5-2' })
    const request = await provider!.buildRequest({
      model: 'glm-5-2',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(JSON.parse(request.body).model).toBe('glm-5-2')
  } finally {
    for (const name of names) {
      const value = previous.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

test('openai-compat translates tool results with images to markdown', async () => {
  const provider = createOpenaiCompatProvider({
    baseURL: 'https://example.invalid/v1',
    apiKey: 'test',
    model: 'gpt-test',
  })
  const req = await provider.buildRequest({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: [
              { type: 'text', text: 'Result is successful' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'fake-base64' },
              },
            ],
          },
        ],
      },
    ],
  })
  const body = JSON.parse(req.body)
  expect(body.messages).toEqual([
    {
      role: 'tool',
      tool_call_id: 'call_123',
      content: 'Result is successful\n![image](data:image/png;base64,fake-base64)',
    },
  ])
})

test('codex translates tool results with images to markdown inline image', async () => {
  const provider = createCodexProvider({ accessToken: 'x.fake.token' })
  const req = await provider.buildRequest({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_123',
            content: [
              { type: 'text', text: 'Screenshot output' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: 'fake-jpeg' },
              },
            ],
          },
        ],
      },
    ],
  })
  const body = JSON.parse(req.body)
  const item = body.input.find((m: any) => m.type === 'function_call_output')
  expect(item).toBeDefined()
  expect(item.output).toBe('Screenshot output\n![image](data:image/jpeg;base64,fake-jpeg)')
})

test('antigravity aggregates multiple images in tool result', () => {
  const block = {
    type: 'tool_result',
    tool_use_id: 'call_123',
    content: [
      { type: 'text', text: 'Multiple screens' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'img1' },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'img2' },
      },
    ],
  }
  const response = toolResultToResponse(block as any)
  expect(response).toEqual({
    media_type: 'image/png',
    data: 'img1',
    text: 'Multiple screens',
    images: [
      { media_type: 'image/png', data: 'img1' },
      { media_type: 'image/jpeg', data: 'img2' },
    ],
  })
})

test('antigravity cleans tool schema for Gemini strictness', async () => {
  const provider = createAntigravityProvider({ model: 'gemini-3.5-flash-high' })
  const req = await provider.buildRequest({
    model: 'gemini-3.5-flash-high',
    messages: [{ role: 'user', content: 'test' }],
    tools: [
      {
        name: 'test_tool',
        description: 'test description',
        input_schema: {
          type: 'object',
          properties: {
            s: { type: 'string', description: 's' },
            n: { type: ['number', 'null'], description: 'n' },
            o: {
              type: 'object',
              properties: {
                i: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
          required: ['s'],
        } as any,
      },
    ],
  })
  const body = JSON.parse(req.body)
  const schema = body.request.tools[0].functionDeclarations[0].parameters

  expect(schema.type).toBe('OBJECT')
  expect(schema.properties.s.type).toBe('STRING')
  expect(schema.properties.n.type).toBe('NUMBER')
  expect(schema.properties.n.nullable).toBe(true)
  expect(schema.properties.o.type).toBe('OBJECT')
  expect(schema.properties.o.properties.i.type).toBe('INTEGER')
  expect(schema.properties.o.additionalProperties).toBeUndefined()
  expect(schema.required).toEqual(['s'])
})
