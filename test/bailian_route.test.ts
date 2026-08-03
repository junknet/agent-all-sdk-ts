import { test, expect } from 'bun:test'
import { pickWireProvider, resolveModel } from '../src/index.js'
import { createOpenaiCompatProvider } from '../src/providers/openai_compat_provider.js'

// DeepSeek platform selection is explicit in the model id. Bare V4 ids default
// to the official Anthropic-compatible endpoint; dated 0731 ids require Bailian.

test('bare deepseek-v4-flash routes to the official Anthropic endpoint', async () => {
  const prevKey = process.env.DEEPSEEK_API_KEY
  const prevBase = process.env.DEEPSEEK_ANTHROPIC_BASE_URL
  process.env.DEEPSEEK_API_KEY = 'sk-official-test'
  process.env.DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
  try {
    const provider = pickWireProvider({ model: 'deepseek-v4-flash' })
    expect(provider?.name).toBe('anthropic-passthrough')
    const request = await provider!.buildRequest({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    })
    expect(request.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(JSON.parse(request.body).model).toBe('deepseek-v4-flash')
  } finally {
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = prevKey
    if (prevBase === undefined) delete process.env.DEEPSEEK_ANTHROPIC_BASE_URL
    else process.env.DEEPSEEK_ANTHROPIC_BASE_URL = prevBase
  }
})

test('bailian prefix routes dated DeepSeek V4 Flash to DashScope', async () => {
  const prevKey = process.env.DASHSCOPE_API_KEY
  const prevBase = process.env.DASHSCOPE_BASE_URL
  process.env.DASHSCOPE_API_KEY = 'sk-bailian-test'
  process.env.DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  try {
    const provider = pickWireProvider({ model: 'bailian/deepseek-v4-flash-0731' })
    expect(provider?.name).toBe('openai-compat')
    const request = await provider!.buildRequest({
      model: 'bailian/deepseek-v4-flash-0731',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    })
    expect(request.url).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    )
    expect(JSON.parse(request.body).model).toBe('deepseek-v4-flash-0731')
  } finally {
    if (prevKey === undefined) delete process.env.DASHSCOPE_API_KEY
    else process.env.DASHSCOPE_API_KEY = prevKey
    if (prevBase === undefined) delete process.env.DASHSCOPE_BASE_URL
    else process.env.DASHSCOPE_BASE_URL = prevBase
  }
})

test('official route rejects the dated model id without a Bailian prefix', () => {
  expect(() => pickWireProvider({ model: 'deepseek-v4-flash-0731' })).toThrow(
    /bailian\/deepseek-v4-flash-0731/,
  )
})
test('DeepSeek route is not changed by the thinking escalation', () => {
  const resolved = resolveModel('deepseek-v4-flash', 'think hard')
  expect(resolved).toEqual({ model: 'deepseek-v4-flash', escalated: false })
})


test('Bailian route sets supportsImages:false so images degrade to a text placeholder', async () => {
  // Exercises the same code path index.ts wires up for deepseek-v4-flash: openai-compat
  // provider constructed with supportsImages:false.
  const provider = createOpenaiCompatProvider({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-test',
    model: 'deepseek-v4-flash-0731',
    supportsImages: false,
  })

  const req = await provider.buildRequest({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this screenshot?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'fake-base64-blob' },
          },
        ],
      },
    ],
  })
  const body = JSON.parse(req.body)
  // No image_url block should reach the wire, and no raw base64 should leak into content.
  const serialized = JSON.stringify(body.messages)
  expect(serialized).not.toContain('image_url')
  expect(serialized).not.toContain('fake-base64-blob')
  expect(body.messages).toEqual([
    {
      role: 'user',
      content: 'what is in this screenshot?\n[image omitted: this model does not support image input]',
    },
  ])
})

test('Bailian route degrades tool_result images to a placeholder, not inline base64 markdown', async () => {
  const provider = createOpenaiCompatProvider({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'sk-test',
    model: 'deepseek-v4-flash-0731',
    supportsImages: false,
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
              { type: 'text', text: 'Screenshot captured' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: 'fake-jpeg-blob' },
              },
            ],
          },
        ],
      },
    ],
  })
  const body = JSON.parse(req.body)
  const serialized = JSON.stringify(body.messages)
  expect(serialized).not.toContain('fake-jpeg-blob')
  expect(body.messages).toEqual([
    {
      role: 'tool',
      tool_call_id: 'call_123',
      content: 'Screenshot captured\n[image omitted: this model does not support image input]',
    },
  ])
})

test('supportsImages defaults to true (unchanged behaviour) when omitted', async () => {
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
  expect(JSON.stringify(body.messages)).toContain('image_url')
})
