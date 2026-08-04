/**
 * Windsurf adapter backed by agent-ir.
 *
 * `agent-all-sdk-ts` owns HTTP ingress/SSE egress and credential discovery;
 * `agent-ir` owns the Connect/protobuf lowering and lifting contract.  Keeping
 * that seam here means the gateway never reimplements Windsurf wire details.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  INGRESS_CODECS,
  checkUpstreamSupport,
  createWindsurfUpstream,
  type IREvent,
  type IRLoss as AgentIrLoss,
} from 'agent-ir'
import type { AnthropicEventEmitter } from '../emitter.js'
import type { AnthropicMessagesRequest, IRLoss, WirePreparedRequest, WireProvider } from '../types.js'

export const WINDSURF_MODEL_PREFIX = 'windsurf-'

/** An explicit prefix is intentional: only these requests consume Windsurf quota. */
export function windsurfModelUid(model: string | undefined): string | null {
  if (!model?.startsWith(WINDSURF_MODEL_PREFIX)) return null
  const uid = model.slice(WINDSURF_MODEL_PREFIX.length)
  return uid.length > 0 ? uid : null
}

export interface LocalWindsurfCredentials {
  readonly apiKey: string
  readonly server?: string
}

function tomlStringValue(document: Record<string, unknown>, key: string): string | undefined {
  const value = document[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Windsurf credential unavailable: credentials.toml ${key} must be a non-empty string`)
  }
  return value
}

/**
 * Reads only root-level credentials. TOML sections deliberately do not inherit
 * into the root document, so a similarly named key in another provider section
 * cannot be selected by accident.
 */
export function parseWindsurfCredentialsToml(toml: string): LocalWindsurfCredentials {
  let document: Record<string, unknown>
  try {
    document = Bun.TOML.parse(toml) as Record<string, unknown>
  } catch (cause) {
    throw new Error('Windsurf credential unavailable: credentials.toml is invalid TOML', { cause })
  }

  const apiKey = tomlStringValue(document, 'windsurf_api_key')
  if (!apiKey) {
    throw new Error('Windsurf credential unavailable: credentials.toml has no root windsurf_api_key')
  }
  const server = tomlStringValue(document, 'api_server_url')
  return { apiKey, ...(server ? { server } : {}) }
}

/**
 * Environment injection wins for deploys.  The local credential fallback is
 * only for the developer workstation, and never logs the token or its path.
 */
export function loadWindsurfCredentials(env: NodeJS.ProcessEnv = process.env): LocalWindsurfCredentials {
  const apiKey = env.WINDSURF_API_KEY
  const server = env.WINDSURF_SERVER_URL
  if (apiKey) return { apiKey, ...(server ? { server } : {}) }

  const credentialFile = join(homedir(), '.local', 'share', 'devin', 'credentials.toml')
  let text: string
  try {
    text = readFileSync(credentialFile, 'utf8')
  } catch {
    throw new Error('Windsurf credential unavailable: set WINDSURF_API_KEY or sign in with the Devin/Windsurf CLI')
  }
  const storedCredentials = parseWindsurfCredentialsToml(text)
  return {
    apiKey: storedCredentials.apiKey,
    ...(server ?? storedCredentials.server ? { server: server ?? storedCredentials.server } : {}),
  }
}

function toGatewayLoss(loss: AgentIrLoss): IRLoss {
  return {
    stage: loss.stage,
    provider: loss.provider,
    path: loss.path,
    kind: loss.kind,
    detail: loss.detail,
  }
}

function stopReason(reason: Extract<IREvent, { kind: 'messageStop' }>['reason']):
  'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' {
  switch (reason) {
    case 'toolUse': return 'tool_use'
    case 'maxTokens': return 'max_tokens'
    case 'stopSequence': return 'stop_sequence'
    // Anthropic's legacy output contract cannot distinguish refusal/abort from a normal stop.
    case 'endTurn':
    case 'refusal':
    case 'aborted':
    case 'error': return 'end_turn'
  }
}

export interface WindsurfAgentIrProviderOptions {
  readonly model: string
  readonly apiKey?: string
  readonly server?: string
}

export function createWindsurfAgentIrProvider(options: WindsurfAgentIrProviderOptions): WireProvider {
  const credentials = options.apiKey
    ? { apiKey: options.apiKey, ...(options.server ? { server: options.server } : {}) }
    : loadWindsurfCredentials()
  const upstream = createWindsurfUpstream({
    model: options.model,
    apiKey: credentials.apiKey,
    ...(options.server ?? credentials.server ? { server: options.server ?? credentials.server } : {}),
  })

  return {
    name: 'windsurf',

    async buildRequest(req: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const { request, losses: ingressLosses } = INGRESS_CODECS.anthropic_messages.readClientRequest(
        req,
        'agent-all-windsurf',
      )
      const verdict = checkUpstreamSupport(request, upstream.profile)
      if (!verdict.admitted) {
        const details = verdict.unsupported
          .map(item => `${item.path}: ${item.capability}`)
          .join('; ')
        throw new Error(`Windsurf cannot represent this request: ${details}`)
      }
      const lowered = await upstream.writeUpstreamRequest(request)
      const losses = [...ingressLosses, ...lowered.losses].map(toGatewayLoss)
      if (!lowered.ok) {
        const details = lowered.problems.map(problem => `${problem.path}: ${problem.detail}`).join('; ')
        throw new Error(`Windsurf request build rejected: ${details}`)
      }
      return {
        url: lowered.wire.url,
        headers: { ...lowered.wire.headers },
        body: lowered.wire.body,
        losses,
      }
    },

    async parseStream(response: Response, emitter: AnthropicEventEmitter): Promise<void> {
      for await (const event of upstream.readUpstreamResponse(response)) {
        switch (event.kind) {
          case 'messageStart':
            emitter.start({ model: event.model })
            break
          case 'partStart':
            if (event.part.kind === 'toolCall') {
              emitter.openToolUse(event.part.call.id, event.part.call.toolRef.name)
            } else if (event.part.kind !== 'text' && event.part.kind !== 'thinking') {
              emitter.unhandled(`windsurf-part-start:${event.part.kind}`, event.part)
            }
            break
          case 'partDelta':
            switch (event.delta.kind) {
              case 'text': emitter.pushText(event.delta.text); break
              case 'thinking': emitter.pushThinking(event.delta.text); break
              case 'toolInputJson': emitter.pushToolArgsDelta(event.delta.json); break
              case 'toolInputText': emitter.pushToolArgsDelta(event.delta.text); break
              case 'thinkingSignature':
                // Anthropic's emitter has no signature-delta method; record rather than discard.
                emitter.unhandled('windsurf-thinking-signature', event.delta)
                break
            }
            break
          case 'partEnd':
            emitter.closeBlock()
            break
          case 'usage':
            emitter.setUsage({
              input: event.usage.inputTokens,
              output: event.usage.outputTokens,
              cacheRead: event.usage.cacheReadTokens,
              cacheCreation: event.usage.cacheWriteTokens,
            })
            break
          case 'messageStop':
            emitter.setStopReason(stopReason(event.reason))
            break
          case 'error':
            emitter.error(new Error(`Windsurf ${event.error.kind}: ${event.error.message}`))
            return
          case 'unhandled':
            emitter.unhandled(event.rawType, event.raw)
            break
          case 'loss':
            // createWireAdapter logs request losses; response losses still must not disappear.
            emitter.unhandled('windsurf-loss', event.loss)
            break
          case 'committed':
          case 'heartbeat':
            break
        }
      }
      emitter.finish()
    },
  }
}
