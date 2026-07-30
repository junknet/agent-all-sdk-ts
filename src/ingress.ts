import type { IngressAdapter, AnthropicMessagesRequest } from './types.js'
import { iterSSE } from './sse.js'
import { decodeResponsesToAnthropic, encodeAnthropicToResponsesSSE } from './responses_api.js'

// ── Messages Ingress Adapter (Anthropic /v1/messages) ────────────────
export class MessagesIngressAdapter implements IngressAdapter {
  readonly protocol = 'messages'

  decodeRequest(rawBody: any): AnthropicMessagesRequest {
    return rawBody as AnthropicMessagesRequest
  }

  encodeResponse(upstreamResponse: Response): Response {
    // Transparent passthrough since upstream already outputs Anthropic SSE
    return upstreamResponse
  }
}

// ── Chat Ingress Adapter (OpenAI /v1/chat/completions) ───────────────
export class ChatIngressAdapter implements IngressAdapter {
  readonly protocol = 'chat'

  decodeRequest(rawBody: any): AnthropicMessagesRequest {
    const messages: any[] = []
    let systemPrompt = ''

    if (Array.isArray(rawBody.messages)) {
      for (const msg of rawBody.messages) {
        if (msg.role === 'system') {
          systemPrompt = (systemPrompt ? systemPrompt + '\n' : '') + msg.content
        } else {
          messages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content,
          })
        }
      }
    }

    const req: any = {
      model: rawBody.model,
      messages,
      stream: rawBody.stream ?? false,
    }

    if (systemPrompt) req.system = systemPrompt
    if (rawBody.max_tokens) req.max_tokens = rawBody.max_tokens
    if (typeof rawBody.temperature === 'number') req.temperature = rawBody.temperature
    if (typeof rawBody.top_p === 'number') req.top_p = rawBody.top_p

    if (Array.isArray(rawBody.tools)) {
      req.tools = rawBody.tools.map((t: any) => ({
        name: t.function?.name,
        description: t.function?.description,
        input_schema: t.function?.parameters,
      }))
    }

    return req
  }

  async encodeResponse(
    upstreamResponse: Response,
    originalRequest: any,
    trace: string,
  ): Promise<Response> {
    const model = originalRequest.model ?? 'openai-compat'

    // Handle Non-Stream Response
    if (!originalRequest.stream) {
      const streamEvents = await iterSSE(upstreamResponse)
      let content = ''
      let reasoning = ''
      const toolCalls: any[] = []

      for await (const ev of streamEvents) {
        try {
          const payload = JSON.parse(ev.data)
          if (payload.type === 'content_block_delta') {
            if (payload.delta?.type === 'text_delta') content += payload.delta.text
            if (payload.delta?.type === 'thinking_delta') reasoning += payload.delta.thinking
            if (payload.delta?.type === 'input_json_delta') {
              const tc = toolCalls[payload.index ?? 0]
              if (tc) tc.function.arguments += payload.delta.partial_json
            }
          }
          if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
            const tc = payload.content_block
            toolCalls[payload.index ?? 0] = {
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: '' },
            }
          }
        } catch {}
      }

      const responseBody: Record<string, any> = {
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: content || null,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls.filter(Boolean) } : {}),
          },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        }],
      }

      return new Response(JSON.stringify(responseBody), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Handle Stream Response: Transform Anthropic SSE stream to OpenAI SSE stream
    const encoder = new TextEncoder()
    const transformStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const event of iterSSE(upstreamResponse)) {
            const openaiChunk = translateAnthropicToOpenAISSE(event, model)
            if (openaiChunk) {
              controller.enqueue(encoder.encode(openaiChunk))
            }
          }
        } catch (err: any) {
          console.error('SSE transformation failed:', err)
        } finally {
          controller.close()
        }
      },
    })

    return new Response(transformStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}

// Helper: translate Anthropic event to OpenAI completions delta
function translateAnthropicToOpenAISSE(event: { event?: string; data: string }, model: string): string | null {
  try {
    const payload = JSON.parse(event.data)
    const id = `chatcmpl-${Date.now().toString(36)}`

    const baseChunk = (delta: any, finishReason: string | null = null) => {
      return JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta,
          finish_reason: finishReason,
        }],
      })
    }

    if (payload.type === 'content_block_delta') {
      const delta = payload.delta
      if (delta.type === 'text_delta') {
        return `data: ${baseChunk({ content: delta.text })}\n\n`
      }
      if (delta.type === 'thinking_delta') {
        return `data: ${baseChunk({ reasoning_content: delta.thinking })}\n\n`
      }
      if (delta.type === 'input_json_delta') {
        return `data: ${baseChunk({
          tool_calls: [{
            index: payload.index ?? 0,
            function: { arguments: delta.partial_json },
          }],
        })}\n\n`
      }
    }

    if (payload.type === 'content_block_start' && payload.content_block?.type === 'tool_use') {
      const tool = payload.content_block
      return `data: ${baseChunk({
        tool_calls: [{
          index: payload.index ?? 0,
          id: tool.id,
          type: 'function',
          function: { name: tool.name, arguments: '' },
        }],
      })}\n\n`
    }

    if (payload.type === 'message_delta') {
      const stopReason = payload.delta?.stop_reason
      const mappedReason = stopReason === 'end_turn' ? 'stop' : stopReason === 'tool_use' ? 'tool_calls' : stopReason
      return `data: ${baseChunk({}, mappedReason)}\n\n`
    }

    if (payload.type === 'message_stop') {
      return 'data: [DONE]\n\n'
    }
  } catch {}
  return null
}

// ── Responses Ingress Adapter (OpenAI Responses /v1/responses) ───────
export class ResponsesIngressAdapter implements IngressAdapter {
  readonly protocol = 'responses'

  decodeRequest(rawBody: any): AnthropicMessagesRequest {
    const { request } = decodeResponsesToAnthropic(rawBody)
    return request
  }

  encodeResponse(
    upstreamResponse: Response,
    originalRequest: any,
    trace: string,
    context?: any,
  ): Response {
    const namespaceTools = context?.namespaceTools
    const stream = encodeAnthropicToResponsesSSE(upstreamResponse, originalRequest.model, trace, namespaceTools)
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }
}

// ── Global Ingress Dispatcher ───────────────────────────────────────
const ADAPTERS: Record<string, IngressAdapter> = {
  messages: new MessagesIngressAdapter(),
  chat: new ChatIngressAdapter(),
  responses: new ResponsesIngressAdapter(),
}

export function pickIngressAdapter(protocol: 'messages' | 'chat' | 'responses'): IngressAdapter {
  const adapter = ADAPTERS[protocol]
  if (!adapter) throw new Error(`Unsupported ingress protocol: ${protocol}`)
  return adapter
}
