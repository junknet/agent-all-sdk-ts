/**
 * Agent Gateway HTTP server implemented using Bun.serve
 */

import { pickWireProvider, createWireAdapter, resolveModel, latestUserInput } from './index.js'
import { pickIngressAdapter } from './ingress.js'
import { decodeResponsesToAnthropic, encodeAnthropicToResponsesSSE } from './responses_api.js'
import { createAntigravityProvider, ANTIGRAVITY_DEFAULT_MODEL } from './providers/antigravity_provider.js'
import { createCodexProvider } from './providers/codex_provider.js'
import { createAnthropicPassthroughProvider } from './providers/anthropic_passthrough_provider.js'
import { detectLocalCredits } from './auth.js'
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

// ── Model listing ──────────────────────────────────────────────────
// Fallback only — used if every provider's live catalog fetch fails.
const FALLBACK_MODELS = [
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
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
  const credits = detectLocalCredits()
  try {
    const codexCredit = credits.find(c => c.provider === 'codex')
    if (codexCredit?.type === 'oauth' && codexCredit.source) {
      const cx = createCodexProvider({ source: codexCredit.source })
      await cx.prepare?.()
      if (cx.listModels) out.push(...(await cx.listModels()))
    }
  } catch (e: any) {
    console.error('listModels codex failed:', e?.message ?? e)
  }
  try {
    const claudeCredit = credits.find(c => c.provider === 'claude')
    if (claudeCredit) {
      const cl = createAnthropicPassthroughProvider({
        baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        apiKey: claudeCredit.type === 'api_key' ? (claudeCredit.value ?? '') : '',
        model: 'claude-opus-5',
        ...(claudeCredit.type === 'oauth' && claudeCredit.source
          ? { source: claudeCredit.source }
          : {}),
      })
      await cl.prepare?.()
      if (cl.listModels) out.push(...(await cl.listModels()))
    }
  } catch (e: any) {
    console.error('listModels claude failed:', e?.message ?? e)
  }
  return out.length > 0 ? out : FALLBACK_MODELS
}

// ── HTTP Gateway Server ─────────────────────────────────────────────
console.log(`Starting TS Gateway Server on port ${PORT}...`)

Bun.serve({
  port: PORT,
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

    // 1. Models endpoint — live aggregated catalog across backends
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      const models = await listAllModels()
      return new Response(JSON.stringify({ data: models }), {
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

        const provider = pickWireProvider({ model: anthropicReq.model, customTokens })
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
        const provider = pickWireProvider({ model: anthropicReq.model, customTokens })
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

        const provider = pickWireProvider({ model: anthropicReq.model, customTokens })
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
