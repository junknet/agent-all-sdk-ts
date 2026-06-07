/**
 * Agent Gateway HTTP server implemented using Bun.serve
 */

import { pickWireProvider, createWireAdapter, resolveModel } from './index.js'

// Pull user-authored text from an inbound request (any protocol) so the gateway can
// detect the 「思考」 escalation trigger. Only user-role text — not assistant/tool output.
function userText(body: any): string {
  const out: string[] = []
  const pushContent = (c: any) => {
    if (typeof c === 'string') out.push(c)
    else if (Array.isArray(c))
      for (const b of c) {
        if (typeof b?.text === 'string') out.push(b.text)
        if (typeof b?.content === 'string') out.push(b.content) // codex input_text variants
      }
  }
  // anthropic /v1/messages + openai /v1/chat
  if (Array.isArray(body?.messages))
    for (const m of body.messages) if (m?.role === 'user') pushContent(m.content)
  // codex /v1/responses input[]
  if (Array.isArray(body?.input))
    for (const it of body.input) {
      if (it?.type === 'message' && it.role === 'user') pushContent(it.content)
      else if (typeof it === 'string') out.push(it)
    }
  if (typeof body?.instructions === 'string') out.push(body.instructions)
  return out.join('\n')
}
import { iterSSE } from './sse.js'
import { decodeResponsesToAnthropic, encodeAnthropicToResponsesSSE } from './responses_api.js'
import { createAntigravityProvider, ANTIGRAVITY_DEFAULT_MODEL } from './providers/antigravity_provider.js'
import { createCodexProvider } from './providers/codex_provider.js'
import { detectLocalCredits } from './auth.js'
import { devlog, newTrace, setTraceMeta } from './devlog.js'

// Identify the connecting harness + conversation session from inbound headers/body, so
// logs split cleanly along two axes: WHICH harness (codex-g / claude-g / jcode) and
// WHICH model — letting us score harness capability and model capability independently.
function identifyClient(
  req: Request,
  protocol: 'responses' | 'messages' | 'chat',
  body: any,
): { harness: string; session: string; ua: string } {
  const ua = req.headers.get('user-agent') ?? ''
  const originator = req.headers.get('originator') ?? ''
  const uaLower = ua.toLowerCase()

  let harness: string
  if (protocol === 'messages') {
    harness = uaLower.includes('claude') ? 'claude-g' : 'anthropic-client'
  } else if (protocol === 'responses') {
    harness = uaLower.includes('codex') || originator.includes('codex') ? 'codex-g' : 'responses-client'
  } else {
    // openai-compat /v1/chat/completions
    harness = uaLower.includes('jcode') ? 'jcode' : uaLower.includes('codex') ? 'codex-chat' : 'openai-compat'
  }

  const session =
    req.headers.get('x-claude-code-session-id') ??
    req.headers.get('x-client-request-id') ??
    (typeof body?.prompt_cache_key === 'string' ? body.prompt_cache_key : null) ??
    body?.metadata?.session_id ??
    'no-session'

  return { harness, session: String(session), ua }
}

const PORT = Number(process.env.AGENT_GATEWAY_PORT ?? 8085)

// ── Model listing ──────────────────────────────────────────────────
// Fallback only — used if every provider's live catalog fetch fails.
const FALLBACK_MODELS = [
  { id: 'gemini-3-flash', name: 'Gemini 3 Flash' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
]

// listAllModels aggregates each backend's authoritative catalog (gemini via
// fetchAvailableModels, codex via /models). Per-provider failures are isolated so one
// dead credential never blanks the whole list.
async function listAllModels(): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = []
  try {
    const ag = createAntigravityProvider({ model: ANTIGRAVITY_DEFAULT_MODEL })
    await ag.prepare?.()
    if (ag.listModels) out.push(...(await ag.listModels()))
  } catch (e: any) {
    console.error('listModels antigravity failed:', e?.message ?? e)
  }
  try {
    const codexCredit = detectLocalCredits().find(c => c.provider === 'codex')
    if (codexCredit?.type === 'oauth' && codexCredit.source) {
      const cx = createCodexProvider({ source: codexCredit.source })
      await cx.prepare?.()
      if (cx.listModels) out.push(...(await cx.listModels()))
    }
  } catch (e: any) {
    console.error('listModels codex failed:', e?.message ?? e)
  }
  return out.length > 0 ? out : FALLBACK_MODELS
}

// ── OpenAI to Anthropic Request Translator ─────────────────────────
function translateOpenAIToAnthropic(openaiReq: any): any {
  const messages: any[] = []
  let systemPrompt = ''

  if (Array.isArray(openaiReq.messages)) {
    for (const msg of openaiReq.messages) {
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
    model: openaiReq.model,
    messages,
    stream: openaiReq.stream ?? false,
  }

  if (systemPrompt) req.system = systemPrompt
  if (openaiReq.max_tokens) req.max_tokens = openaiReq.max_tokens
  if (typeof openaiReq.temperature === 'number') req.temperature = openaiReq.temperature
  if (typeof openaiReq.top_p === 'number') req.top_p = openaiReq.top_p

  if (Array.isArray(openaiReq.tools)) {
    req.tools = openaiReq.tools.map((t: any) => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters,
    }))
  }

  return req
}

// ── Anthropic SSE to OpenAI completion chunk ─────────────────────────
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

// ── HTTP Gateway Server ─────────────────────────────────────────────
console.log(`Starting TS Gateway Server on port ${PORT}...`)

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    console.log(`HIT: ${req.method} ${url.pathname}`)

    // 1. Models endpoint — live aggregated catalog across backends
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const models = await listAllModels()
      return new Response(JSON.stringify({ data: models }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // 2. Anthropic Messages API (claude-g)
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      const trace = newTrace()
      try {
        const bodyText = await req.text()
        const body = JSON.parse(bodyText)
        const cid = identifyClient(req, 'messages', body)
        const origModel = body.model
        const resolved = resolveModel(body.model, userText(body)) // haiku→cheap, 思考→high
        body.model = resolved.model
        setTraceMeta(trace, { harness: cid.harness, model: body.model, session: cid.session, ua: cid.ua, requested: origModel, escalated: resolved.escalated })
        devlog(trace, 'inbound', {
          protocol: 'messages',
          path: url.pathname,
          model: body.model,
          stream: body.stream,
          thinking: body.thinking,
          messageCount: Array.isArray(body.messages) ? body.messages.length : 0,
          toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
          body,
        })
        const provider = pickWireProvider({ model: body.model })
        if (!provider) {
          devlog(trace, 'error', { at: 'pickProvider', model: body.model })
          return new Response(JSON.stringify({ error: `No provider found for model: ${body.model}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const adapter = createWireAdapter(provider)
        const response = await adapter('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dev-trace': trace },
          body: JSON.stringify(body), // remapped model
        })
        return response
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // 3. Codex Responses API (codex-g, wire_api="responses"): instructions + input[]
    //    in, response.* events out. Distinct wire shape from chat completions — must
    //    NOT be conflated (see responses_api.ts).
    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      const trace = newTrace()
      try {
        const responsesReq = await req.json()
        const cid = identifyClient(req, 'responses', responsesReq)
        setTraceMeta(trace, { harness: cid.harness, model: responsesReq.model, session: cid.session, ua: cid.ua })
        devlog(trace, 'inbound', {
          protocol: 'responses',
          path: url.pathname,
          model: responsesReq.model,
          reasoning: responsesReq.reasoning,
          inputCount: Array.isArray(responsesReq.input) ? responsesReq.input.length : 0,
          toolCount: Array.isArray(responsesReq.tools) ? responsesReq.tools.length : 0,
          body: responsesReq,
        })
        const { request: anthropicReq, namespaceTools, droppedNamespaces } =
          decodeResponsesToAnthropic(responsesReq)
        if (droppedNamespaces.length > 0) {
          // Gemini's 128-tool cap forced these namespaces out; surface it, never silently truncate.
          devlog(trace, 'tools_capped', { kept: namespaceTools.size, dropped: droppedNamespaces })
        }
        anthropicReq.model = resolveModel(anthropicReq.model, userText(responsesReq)).model // haiku→cheap, 思考→high
        const provider = pickWireProvider({ model: anthropicReq.model })
        if (!provider) {
          devlog(trace, 'error', { at: 'pickProvider', model: anthropicReq.model })
          return new Response(
            JSON.stringify({ error: `No provider found for model: ${anthropicReq.model}` }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const adapter = createWireAdapter(provider)
        const anthropicResponse = await adapter('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dev-trace': trace },
          body: JSON.stringify({ ...anthropicReq, stream: true }),
        })
        if (!anthropicResponse.ok) return anthropicResponse

        const stream = encodeAnthropicToResponsesSSE(anthropicResponse, responsesReq.model, trace, namespaceTools)
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        })
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // 4. OpenAI Chat Completions (openai-compat clients, e.g. jcode)
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const trace = newTrace()
      try {
        const openaiReq = await req.json()
        const cid = identifyClient(req, 'chat', openaiReq)
        setTraceMeta(trace, { harness: cid.harness, model: openaiReq.model, session: cid.session, ua: cid.ua })
        devlog(trace, 'inbound', {
          protocol: 'chat',
          path: url.pathname,
          model: openaiReq.model,
          stream: openaiReq.stream,
          messageCount: Array.isArray(openaiReq.messages) ? openaiReq.messages.length : 0,
          body: openaiReq,
        })
        const anthropicReq = translateOpenAIToAnthropic(openaiReq)
        anthropicReq.model = resolveModel(anthropicReq.model, userText(openaiReq)).model // haiku→cheap, 思考→high

        const provider = pickWireProvider({ model: anthropicReq.model })
        if (!provider) {
          devlog(trace, 'error', { at: 'pickProvider', model: anthropicReq.model })
          return new Response(JSON.stringify({ error: `No provider found for model: ${anthropicReq.model}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const adapter = createWireAdapter(provider)
        const anthropicResponse = await adapter('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dev-trace': trace },
          body: JSON.stringify(anthropicReq),
        })

        if (!anthropicResponse.ok) {
          return anthropicResponse
        }

        // Handle Non-Stream Response
        if (!openaiReq.stream) {
          const streamEvents = await iterSSE(anthropicResponse)
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
            model: openaiReq.model,
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
              for await (const event of iterSSE(anthropicResponse)) {
                const openaiChunk = translateAnthropicToOpenAISSE(event, openaiReq.model)
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
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  },
})
