/** ChatGPT Codex 的宿主装配：认证、WebSocket 连接和模型映射留在此处，协议语义全部归 agent-ir。 */
import {
  checkOutboxSupport,
  createCodexWebSocketResponseOutbox,
  writeInboxResponseFromEvents,
  type IRLoss as AgentIrLoss,
} from 'agent-ir'
import type { TokenSource } from '../auth.js'
import type {
  AnthropicMessagesRequest,
  ModelInfo,
  QuotaInfo,
  WirePreparedRequest,
  WireProvider,
} from '../types.js'
import { CODEX_MODELS, DEFAULT_CODEX_MODEL, mapClaudeModelToCodex } from './codex_models.js'
import { readCodexWebSocketFrames } from './codex_websocket_transport.js'
import { readAnthropicInboxRequest, toGatewayLoss } from './openai_responses_outbox.js'

import { generateCodexAttestationHeader } from './codex_attestation.js'

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const CODEX_WEBSOCKET_URL = 'wss://chatgpt.com/backend-api/codex/responses'
const CODEX_WEBSOCKET_BETA = 'responses_websockets=2026-02-06'
const CODEX_TUI_USER_AGENT = 'codex-tui/0.146.0'

export interface CodexResponsesOutboxOptions {
  readonly accessToken?: string
  readonly source?: TokenSource
  readonly model?: string
}

function extractAccountId(token: string): string {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid Codex JWT (expected 3 parts)')
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf-8'))
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
  if (!accountId) throw new Error('Codex JWT missing chatgpt_account_id claim')
  return String(accountId)
}

function toGatewayLosses(losses: readonly AgentIrLoss[]) {
  return losses.map(toGatewayLoss)
}

/** local-gpt-* 的单轨 Codex WebSocket Outbox。 */
export function createCodexResponsesOutboxProvider(options: CodexResponsesOutboxOptions): WireProvider {
  let accessToken = options.accessToken ?? ''
  let accountId = ''
  const installationId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const threadId = crypto.randomUUID()

  return {
    name: 'codex',

    async prepare(): Promise<void> {
      if (options.source) accessToken = await options.source.token()
      accountId = extractAccountId(accessToken)
    },

    async buildRequest(request: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const model = options.model ?? mapClaudeModelToCodex(request.model ?? null)
      const timeoutMs = process.env.NODE_ENV === 'test' || process.env.BUN_TEST ? 1200 : 8000
      const attestationHeader = await generateCodexAttestationHeader(timeoutMs)

      const outbox = createCodexWebSocketResponseOutbox({
        model,
        supportsMaxOutputTokens: false,
        webSocketUrl: CODEX_WEBSOCKET_URL,
        webSocketHeaders: {
          authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
          originator: 'codex-tui',
          'user-agent': CODEX_TUI_USER_AGENT,
          'openai-beta': CODEX_WEBSOCKET_BETA,
          'session-id': sessionId,
          session_id: sessionId,
          'thread-id': threadId,
          'x-client-request-id': threadId,
          'x-codex-installation-id': installationId,
          'x-oai-attestation': attestationHeader,
        },
        clientMetadata: { installationId, sessionId, threadId, windowId: installationId },
      })
      const decoded = readAnthropicInboxRequest(request, 'agent-all-codex')
      const verdict = checkOutboxSupport(decoded.request, outbox.profile, 'codex_websocket')
      if (!verdict.admitted) {
        throw new Error(`Codex WebSocket cannot represent this request: ${verdict.unsupported.map(item => `${item.paths.join(', ')}: ${item.capability}`).join('; ')}`)
      }
      const compiled = await outbox.writeCodexWebSocketResponseCreate(decoded.request)
      if (!compiled.ok) {
        throw new Error(`Codex WebSocket request build rejected: ${compiled.problems.map(problem => `${problem.path}: ${problem.detail}`).join('; ')}`)
      }

      return {
        url: compiled.frame.url,
        headers: { ...compiled.frame.headers },
        body: compiled.frame.payload,
        losses: [...toGatewayLosses(decoded.losses), ...toGatewayLosses(compiled.losses)],
        createAnthropicInboxResponse: observation => writeInboxResponseFromEvents({
          protocol: 'anthropic_messages',
          clientRequest: decoded.request,
          events: outbox.readCodexWebSocketResponseEvents(
            decoded.request.intent.identity.sessionId,
            readCodexWebSocketFrames(compiled.frame),
            observation?.inspectOutboxSseFrame
              ? { inspectCompleteSseFrame: observation.inspectOutboxSseFrame }
              : undefined,
          ),
          observeGuardedIREvent: observation?.observeGuardedIREvent,
          encodeOptions: {
            messageId: `msg_codex_${crypto.randomUUID().replaceAll('-', '')}`,
            runCompleteIRResponseInterception: observation?.observeCompletedResponse,
          },
        }),
      }
    },

    async listModels(): Promise<ModelInfo[]> {
      return CODEX_MODELS.map(model => ({
        id: model.id,
        name: model.label,
        contextWindow: 1048576,
        maxOutputTokens: 1048576,
        supportsTools: true,
        supportsImages: true,
      }))
    },

    async getQuota(): Promise<QuotaInfo> {
      return options.source?.getQuota?.() ?? { planType: 'codex-free' }
    },
  }
}

export { DEFAULT_CODEX_MODEL }
