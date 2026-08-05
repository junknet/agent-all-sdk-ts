/** 标准 OpenAI Responses 端点的宿主装配；协议转换由 agent-ir 完整负责。 */
import {
  checkOutboxSupport,
  clientValue,
  createOpenAIResponsesOutbox,
  defaultValue,
  deriveCapabilityNeeds,
  INBOX_CODECS,
  type IRLoss as AgentIrLoss,
  type IRReasoning,
  type IRRequest,
  type IROutbox,
  writeInboxResponseFromOutbox,
} from 'agent-ir'
import type {
  AgentIrResponseObservation, AnthropicMessagesRequest, IRLoss, ReasoningIntent, WirePreparedRequest, WireProvider,
} from '../types.js'

export interface OpenAIResponsesOutboxProviderOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly authScheme?: 'bearer' | 'x-api-key'
}

export interface AgentIrResponsesOutboxRequest {
  readonly outbox: IROutbox
  readonly request: AnthropicMessagesRequest
  readonly traceId: string
  readonly messageIdPrefix: string
}

export function toGatewayLoss(loss: AgentIrLoss): IRLoss {
  return {
    stage: loss.stage === 'inbox' ? 'inbox' : 'outbox', provider: loss.outbox,
    path: loss.path, kind: loss.kind, detail: loss.detail,
  }
}

function toAgentIrReasoning(reasoning: ReasoningIntent): IRReasoning {
  switch (reasoning.mode) {
    case 'disabled': return { mode: 'disabled', display: 'hidden' }
    case 'auto': return { mode: 'auto', display: 'summarized' }
    case 'effort': return { mode: 'enabled', display: 'summarized', effort: reasoning.effort }
    case 'budget': return { mode: 'enabled', display: 'summarized', budgetTokens: reasoning.budgetTokens }
  }
}

export function readAnthropicInboxRequest(request: AnthropicMessagesRequest, traceId: string): {
  readonly request: IRRequest
  readonly losses: readonly AgentIrLoss[]
} {
  const decoded = INBOX_CODECS.anthropic_messages.readClientRequest(request, traceId)
  if (!request.reasoning && !request.serviceTier) return decoded
  const intent = {
    ...decoded.request.intent,
    ...(request.reasoning
      ? { reasoning: request.reasoning.source === 'client'
        ? clientValue(toAgentIrReasoning(request.reasoning))
        : defaultValue(toAgentIrReasoning(request.reasoning)) }
      : {}),
    ...(request.serviceTier ? { serviceTier: clientValue(request.serviceTier.tier) } : {}),
  }
  const partial = { ...decoded.request, intent }
  return { request: { ...partial, requires: deriveCapabilityNeeds(partial) }, losses: decoded.losses }
}

/** 将已装配好的 Responses Outbox 降级为网关 wire 请求，并交回 agent-ir 的单轨回写器。 */
export async function buildAgentIrResponsesOutboxRequest(
  options: AgentIrResponsesOutboxRequest,
): Promise<WirePreparedRequest> {
  const decoded = readAnthropicInboxRequest(options.request, options.traceId)
  const verdict = checkOutboxSupport(decoded.request, options.outbox.profile, 'openai_responses')
  if (!verdict.admitted) {
    throw new Error(`OpenAI Responses cannot represent this request: ${verdict.unsupported.map(item => `${item.paths.join(', ')}: ${item.capability}`).join('; ')}`)
  }
  const lowered = await options.outbox.writeOutboxRequest(decoded.request)
  if (!lowered.ok) {
    throw new Error(`OpenAI Responses request build rejected: ${lowered.problems.map(problem => `${problem.path}: ${problem.detail}`).join('; ')}`)
  }
  return {
    url: lowered.wire.url,
    headers: { ...lowered.wire.headers },
    body: lowered.wire.body,
    losses: [...decoded.losses, ...lowered.losses].map(toGatewayLoss),
    writeAnthropicInboxResponse: (
      response: Response,
      observation?: AgentIrResponseObservation,
    ): Response | Promise<Response> =>
      writeInboxResponseFromOutbox({
        protocol: 'anthropic_messages', clientRequest: decoded.request, outbox: options.outbox, outboxResponse: response,
        readOptions: observation?.inspectOutboxSseFrame
          ? { inspectCompleteSseFrame: observation.inspectOutboxSseFrame }
          : undefined,
        observeGuardedIREvent: observation?.observeGuardedIREvent,
        encodeOptions: {
          messageId: `${options.messageIdPrefix}_${crypto.randomUUID().replaceAll('-', '')}`,
          runCompleteIRResponseInterception: observation?.observeCompletedResponse,
        },
      }),
  }
}

export function createOpenAIResponsesOutboxProvider(options: OpenAIResponsesOutboxProviderOptions): WireProvider {
  return {
    name: 'codex',
    async buildRequest(request: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const outbox = createOpenAIResponsesOutbox({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
        extraHeaders: options.authScheme === 'x-api-key' ? { 'x-api-key': options.apiKey } : undefined,
      })
      const prepared = await buildAgentIrResponsesOutboxRequest({
        outbox, request, traceId: 'agent-all-openai-responses', messageIdPrefix: 'msg_responses',
      })
      const headers = { ...prepared.headers }
      if (options.authScheme === 'x-api-key') {
        delete headers.authorization
        headers['x-api-key'] = options.apiKey
      }
      return {
        ...prepared,
        headers,
      }
    },
  }
}
