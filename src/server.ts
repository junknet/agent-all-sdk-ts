/**
 * Agent Gateway HTTP server implemented using Bun.serve
 */

import { pickWireProvider, createWireAdapter, resolveModel, latestUserInput } from './index.js'
import { pickIngressAdapter } from './ingress.js'
import { decodeResponsesToAnthropic, encodeAnthropicToResponsesSSE } from './responses_api.js'
import { createModelsListResponse, listAvailableModels } from './model_catalog.js'
import { slimAnthropicRequest } from './slim.js'
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

// ── HTTP Gateway Server ─────────────────────────────────────────────
console.log(`Starting TS Gateway Server on port ${PORT}...`)

Bun.serve({
  port: PORT,
  // Bun.serve 默认 idleTimeout 10s —— agent 请求经常在两个 SSE chunk 之间静默更久
  // (上游思考、工具往返)，会被就地掐断，客户端看到的是
  // "The socket connection was closed unexpectedly"，与业务无关且极难归因。
  // 255 是 Bun 允许的上限。
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)

    // 入口鉴权：对外暴露时校验 Bearer key。GATEWAY_API_KEY 未设则不校验（纯内网/开发）。
    const requiredKey = process.env.GATEWAY_API_KEY
    if (requiredKey) {
      const auth = req.headers.get('authorization') ?? ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      // OpenAI SDK 用 Authorization: Bearer；Anthropic SDK 用 x-api-key——两者都接受
      const token = bearer || (req.headers.get('x-api-key') ?? '')
      if (token !== requiredKey) {
        return new Response(
          JSON.stringify({ error: { message: 'Unauthorized', type: 'authentication_error' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    console.log(`HIT: ${req.method} ${url.pathname}`)

    // 1. Models endpoint — curated public catalog filtered by available credentials
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const models = await listAvailableModels()
      return new Response(JSON.stringify(createModelsListResponse(models)), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const customTokens = {
      claudeAccessToken: req.headers.get('x-gateway-claude-access-token') || req.headers.get('x-gateway-claude-token') || undefined,
      claudeRefreshToken: req.headers.get('x-gateway-claude-refresh-token') || undefined,
      codexAccessToken: req.headers.get('x-gateway-codex-access-token') || req.headers.get('x-gateway-codex-token') || undefined,
      codexRefreshToken: req.headers.get('x-gateway-codex-refresh-token') || undefined,
      geminiAccessToken: req.headers.get('x-gateway-gemini-access-token') || req.headers.get('x-gateway-gemini-token') || undefined,
    }

    // 2. Anthropic Messages API (claude-g)
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      const trace = newTrace()
      try {
        const bodyText = await req.text()
        const body = JSON.parse(bodyText)
        const cid = identifyClient(req, 'messages', body)
        const origModel = body.model

        const adapter = pickIngressAdapter('messages')
        const anthropicReq = adapter.decodeRequest(body)

        const resolved = resolveModel(anthropicReq.model, latestUserInput(body))
        anthropicReq.model = resolved.model

        const slim = slimAnthropicRequest(anthropicReq)
        if (slim.on) console.log(`[slim] messages: tools ${slim.toolsBefore}→${slim.toolsAfter}, system ${slim.sysBefore}→${slim.sysAfter} chars`)

        setTraceMeta(trace, { harness: cid.harness, model: anthropicReq.model, session: cid.session, ua: cid.ua, requested: origModel, escalated: resolved.escalated })
        devlog(trace, 'inbound', {
          protocol: 'messages',
          path: url.pathname,
          model: anthropicReq.model,
          stream: anthropicReq.stream,
          thinking: anthropicReq.thinking,
          messageCount: Array.isArray(anthropicReq.messages) ? anthropicReq.messages.length : 0,
          toolCount: Array.isArray(anthropicReq.tools) ? anthropicReq.tools.length : 0,
          body,
        })

        const provider = pickWireProvider({
          model: anthropicReq.model,
          customTokens,
          // 透传客户端声明的 beta，见 anthropic_passthrough_provider.mergeBeta
          inboundBeta: req.headers.get('anthropic-beta') ?? undefined,
        })
        if (!provider) {
          devlog(trace, 'error', { at: 'pickProvider', model: anthropicReq.model })
          return new Response(JSON.stringify({ error: `No provider found for model: ${anthropicReq.model}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const wireAdapter = createWireAdapter(provider)
        const response = await wireAdapter('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dev-trace': trace },
          body: JSON.stringify(anthropicReq),
        })

        return adapter.encodeResponse(response, body, trace)
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // 3. Codex Responses API (codex-g, wire_api="responses")
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

        const adapter = pickIngressAdapter('responses')
        const { request: anthropicReq, namespaceTools, droppedNamespaces } =
          decodeResponsesToAnthropic(responsesReq)
        
        if (droppedNamespaces.length > 0) {
          devlog(trace, 'tools_capped', { kept: namespaceTools.size, dropped: droppedNamespaces })
        }

        anthropicReq.model = resolveModel(anthropicReq.model, latestUserInput(responsesReq)).model
        const slimR = slimAnthropicRequest(anthropicReq)
        if (slimR.on) console.log(`[slim] responses: tools ${slimR.toolsBefore}→${slimR.toolsAfter}, system ${slimR.sysBefore}→${slimR.sysAfter} chars`)
        const provider = pickWireProvider({
          model: anthropicReq.model,
          customTokens,
          // 透传客户端声明的 beta，见 anthropic_passthrough_provider.mergeBeta
          inboundBeta: req.headers.get('anthropic-beta') ?? undefined,
        })
        if (!provider) {
          devlog(trace, 'error', { at: 'pickProvider', model: anthropicReq.model })
          return new Response(
            JSON.stringify({ error: `No provider found for model: ${anthropicReq.model}` }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const wireAdapter = createWireAdapter(provider)
        const anthropicResponse = await wireAdapter('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dev-trace': trace },
          body: JSON.stringify({ ...anthropicReq, stream: true }),
        })

        if (!anthropicResponse.ok) return anthropicResponse

        return adapter.encodeResponse(anthropicResponse, responsesReq, trace, { namespaceTools })
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // 4. OpenAI Chat Completions (openai-compat clients)
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

        const adapter = pickIngressAdapter('chat')
        const anthropicReq = adapter.decodeRequest(openaiReq)
        anthropicReq.model = resolveModel(anthropicReq.model, latestUserInput(openaiReq)).model

        const slimC = slimAnthropicRequest(anthropicReq)
        if (slimC.on) console.log(`[slim] chat: tools ${slimC.toolsBefore}→${slimC.toolsAfter}, system ${slimC.sysBefore}→${slimC.sysAfter} chars`)

        const provider = pickWireProvider({
          model: anthropicReq.model,
          customTokens,
          // 透传客户端声明的 beta，见 anthropic_passthrough_provider.mergeBeta
          inboundBeta: req.headers.get('anthropic-beta') ?? undefined,
        })
        if (!provider) {
          devlog(trace, 'error', { at: 'pickProvider', model: anthropicReq.model })
          return new Response(JSON.stringify({ error: `No provider found for model: ${anthropicReq.model}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const wireAdapter = createWireAdapter(provider)
        const anthropicResponse = await wireAdapter('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dev-trace': trace },
          body: JSON.stringify(anthropicReq),
        })

        if (!anthropicResponse.ok) return anthropicResponse

        return adapter.encodeResponse(anthropicResponse, openaiReq, trace)
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
