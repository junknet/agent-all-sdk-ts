/**
 * Agent Gateway HTTP server implemented using Bun.serve
 */

import { selectWireProvider, createWireAdapter, resolveModel, latestUserInput } from './index.js'
import { upstreamModelId } from './model_registry.js'
import { pickIngressAdapter } from './inbox.js'
import { decodeResponsesToAnthropic, encodeAnthropicToResponsesSSE } from './responses_api.js'
import { createModelsListResponse, listAvailableModels } from './model_catalog.js'
import { slimAnthropicRequest } from './slim.js'
import {
  createGatewayLogger,
  createGatewayRequestLogger,
  createGatewayTraceId,
  logGatewayIRLosses,
} from './logging.js'

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
// Set only by the real-agent gate.  A nonce, rather than an ordinary 200 health
// response, proves that the harness reached the process it just launched and
// not an unrelated gateway already bound to the selected port.
const AGENT_GATEWAY_READY_NONCE = process.env.AGENT_GATEWAY_READY_NONCE
const gatewayLogger = createGatewayLogger()

// ── HTTP Gateway Server ─────────────────────────────────────────────
gatewayLogger.info({ event: 'gateway.server_started', port: PORT }, 'Starting TypeScript gateway server')

Bun.serve({
  port: PORT,
  // Bun.serve 默认 idleTimeout 10s —— agent 请求经常在两个 SSE chunk 之间静默更久
  // (上游思考、工具往返)，会被就地掐断，客户端看到的是
  // "The socket connection was closed unexpectedly"，与业务无关且极难归因。
  // 255 是 Bun 允许的上限。
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const requestTrace = req.headers.get('x-dev-trace') ?? createGatewayTraceId()
    const requestLogger = createGatewayRequestLogger(gatewayLogger, requestTrace, {
      method: req.method,
      path: url.pathname,
    })

    if (
      AGENT_GATEWAY_READY_NONCE &&
      req.method === 'GET' &&
      url.pathname === '/__agent_gate_ready'
    ) {
      return new Response(AGENT_GATEWAY_READY_NONCE, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Agent-Gate-Nonce': AGENT_GATEWAY_READY_NONCE,
        },
      })
    }

    // 入口鉴权：对外暴露时校验 Bearer key。GATEWAY_API_KEY 未设则不校验（纯内网/开发）。
    const requiredKey = process.env.GATEWAY_API_KEY
    if (requiredKey) {
      const auth = req.headers.get('authorization') ?? ''
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
      // OpenAI SDK 用 Authorization: Bearer；Anthropic SDK 用 x-api-key——两者都接受
      const token = bearer || (req.headers.get('x-api-key') ?? '')
      if (token !== requiredKey) {
        requestLogger.warn({ event: 'inbox.authentication_rejected' }, 'Rejected unauthenticated gateway request')
        return new Response(
          JSON.stringify({ error: { message: 'Unauthorized', type: 'authentication_error' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    requestLogger.debug({ event: 'inbox.request_received' }, 'Received gateway request')

    // 1. Models endpoint — curated public catalog filtered by available credentials
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      requestLogger.debug({ event: 'inbox.models_requested' }, 'Listing available models')
      const models = await listAvailableModels()
      requestLogger.info({ event: 'inbox.models_completed', modelCount: models.length }, 'Listed available models')
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
      const trace = requestTrace
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
        const inboundLogger = createGatewayRequestLogger(requestLogger, trace, {
          harness: cid.harness,
          model: anthropicReq.model,
          session: cid.session,
          requestedModel: origModel,
          modelEscalated: resolved.escalated,
        })
        if (slim.on) {
          inboundLogger.debug(
            { event: 'inbox.request_slimmed', toolsBefore: slim.toolsBefore, toolsAfter: slim.toolsAfter, systemBefore: slim.sysBefore, systemAfter: slim.sysAfter },
            'Slimmed Messages request before routing',
          )
        }
        inboundLogger.info({
          event: 'inbox.request_decoded',
          protocol: 'messages',
          stream: anthropicReq.stream,
          thinking: anthropicReq.thinking,
          messageCount: Array.isArray(anthropicReq.messages) ? anthropicReq.messages.length : 0,
          toolCount: Array.isArray(anthropicReq.tools) ? anthropicReq.tools.length : 0,
        }, 'Decoded Messages inbox request')

        const provider = await selectWireProvider({
          model: anthropicReq.model,
          customTokens,
          // 透传客户端声明的 beta，见 anthropic_passthrough_provider.mergeBeta
          inboundBeta: req.headers.get('anthropic-beta') ?? undefined,
        })
        // 通道前缀只用于选出口, 上游只认自己的裸 id。必须在选完 provider 之后剥,
        // 之前剥就分不出 local-claude-opus-5 和 ccr-claude-opus-5 了。
        anthropicReq.model = upstreamModelId(anthropicReq.model)
        if (!provider) {
          inboundLogger.warn({ event: 'outbox.selection_failed' }, 'No outbox matched requested model')
          return new Response(JSON.stringify({ error: `No provider found for model: ${anthropicReq.model}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const wireAdapter = createWireAdapter(provider, inboundLogger)
        const response = await wireAdapter('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dev-trace': trace },
          body: JSON.stringify(anthropicReq),
        })

        return adapter.encodeResponse(response, body, trace, { logger: inboundLogger })
      } catch (error: any) {
        requestLogger.error({ event: 'inbox.request_failed', error }, 'Messages inbox request failed')
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // 3. Codex Responses API (codex-g, wire_api="responses")
    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      const trace = requestTrace
      try {
        const responsesReq: any = await req.json()
        const cid = identifyClient(req, 'responses', responsesReq)
        const inboundLogger = createGatewayRequestLogger(requestLogger, trace, {
          harness: cid.harness,
          model: responsesReq.model,
          session: cid.session,
        })
        inboundLogger.info({
          event: 'inbox.request_decoded',
          protocol: 'responses',
          reasoning: responsesReq.reasoning,
          inputCount: Array.isArray(responsesReq.input) ? responsesReq.input.length : 0,
          toolCount: Array.isArray(responsesReq.tools) ? responsesReq.tools.length : 0,
        }, 'Decoded Responses inbox request')

        const adapter = pickIngressAdapter('responses')
        const { request: anthropicReq, namespaceTools, droppedNamespaces, losses } =
          decodeResponsesToAnthropic(responsesReq)

        if (droppedNamespaces.length > 0) {
          inboundLogger.warn(
            { event: 'inbox.tool_namespaces_capped', kept: namespaceTools.size, dropped: droppedNamespaces },
            'Responses inbox exceeded the outbox tool budget',
          )
        }
        logGatewayIRLosses(inboundLogger, losses)

        anthropicReq.model = resolveModel(anthropicReq.model, latestUserInput(responsesReq)).model
        const slimR = slimAnthropicRequest(anthropicReq)
        if (slimR.on) {
          inboundLogger.debug(
            { event: 'inbox.request_slimmed', toolsBefore: slimR.toolsBefore, toolsAfter: slimR.toolsAfter, systemBefore: slimR.sysBefore, systemAfter: slimR.sysAfter },
            'Slimmed Responses request before routing',
          )
        }
        const provider = await selectWireProvider({
          model: anthropicReq.model,
          customTokens,
          // 透传客户端声明的 beta，见 anthropic_passthrough_provider.mergeBeta
          inboundBeta: req.headers.get('anthropic-beta') ?? undefined,
        })
        // 通道前缀只用于选出口, 上游只认自己的裸 id。必须在选完 provider 之后剥,
        // 之前剥就分不出 local-claude-opus-5 和 ccr-claude-opus-5 了。
        anthropicReq.model = upstreamModelId(anthropicReq.model)
        if (!provider) {
          inboundLogger.warn({ event: 'outbox.selection_failed' }, 'No outbox matched requested model')
          return new Response(
            JSON.stringify({ error: `No provider found for model: ${anthropicReq.model}` }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          )
        }

        const wireAdapter = createWireAdapter(provider, inboundLogger)
        const anthropicResponse = await wireAdapter('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dev-trace': trace },
          body: JSON.stringify({ ...anthropicReq, stream: true }),
        })

        if (!anthropicResponse.ok) return anthropicResponse

        return adapter.encodeResponse(anthropicResponse, responsesReq, trace, { namespaceTools, logger: inboundLogger })
      } catch (error: any) {
        requestLogger.error({ event: 'inbox.request_failed', error }, 'Responses inbox request failed')
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    // 4. OpenAI Chat Completions (openai-compat clients)
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const trace = requestTrace
      try {
        const openaiReq: any = await req.json()
        const cid = identifyClient(req, 'chat', openaiReq)
        const inboundLogger = createGatewayRequestLogger(requestLogger, trace, {
          harness: cid.harness,
          model: openaiReq.model,
          session: cid.session,
        })
        inboundLogger.info({
          event: 'inbox.request_decoded',
          protocol: 'chat',
          stream: openaiReq.stream,
          messageCount: Array.isArray(openaiReq.messages) ? openaiReq.messages.length : 0,
          toolCount: Array.isArray(openaiReq.tools) ? openaiReq.tools.length : 0,
        }, 'Decoded Chat Completions inbox request')

        const adapter = pickIngressAdapter('chat')
        const anthropicReq = adapter.decodeRequest(openaiReq)
        anthropicReq.model = resolveModel(anthropicReq.model, latestUserInput(openaiReq)).model

        const slimC = slimAnthropicRequest(anthropicReq)
        if (slimC.on) {
          inboundLogger.debug(
            { event: 'inbox.request_slimmed', toolsBefore: slimC.toolsBefore, toolsAfter: slimC.toolsAfter, systemBefore: slimC.sysBefore, systemAfter: slimC.sysAfter },
            'Slimmed Chat Completions request before routing',
          )
        }

        const provider = await selectWireProvider({
          model: anthropicReq.model,
          customTokens,
          // 透传客户端声明的 beta，见 anthropic_passthrough_provider.mergeBeta
          inboundBeta: req.headers.get('anthropic-beta') ?? undefined,
        })
        // 通道前缀只用于选出口, 上游只认自己的裸 id。必须在选完 provider 之后剥,
        // 之前剥就分不出 local-claude-opus-5 和 ccr-claude-opus-5 了。
        anthropicReq.model = upstreamModelId(anthropicReq.model)
        if (!provider) {
          inboundLogger.warn({ event: 'outbox.selection_failed' }, 'No outbox matched requested model')
          return new Response(JSON.stringify({ error: `No provider found for model: ${anthropicReq.model}` }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        }

        const wireAdapter = createWireAdapter(provider, inboundLogger)
        const anthropicResponse = await wireAdapter('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-dev-trace': trace },
          body: JSON.stringify(anthropicReq),
        })

        if (!anthropicResponse.ok) return anthropicResponse

        return adapter.encodeResponse(anthropicResponse, openaiReq, trace, { logger: inboundLogger })
      } catch (error: any) {
        requestLogger.error({ event: 'inbox.request_failed', error }, 'Chat Completions inbox request failed')
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }

    requestLogger.warn({ event: 'inbox.route_not_found' }, 'Gateway route was not found')
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  },
})
