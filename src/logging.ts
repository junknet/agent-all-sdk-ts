/**
 * Gateway logging boundary.
 *
 * Logging is process-output only: it never creates files, buffers request payloads, or
 * changes the request/response flow. Callers receive a Pino logger explicitly and create
 * a child per request, which keeps every record for one gateway transaction searchable by
 * the same trace id.
 */

import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino'
import pinoPretty from 'pino-pretty'
import type { IRLoss } from './types.js'

export const GATEWAY_LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const
export type GatewayLogLevel = (typeof GATEWAY_LOG_LEVELS)[number]
export const GATEWAY_LOG_FORMATS = ['text', 'json'] as const
export type GatewayLogFormat = (typeof GATEWAY_LOG_FORMATS)[number]
export type GatewayLogger = PinoLogger

export interface GatewayLoggingSettings {
  readonly level: GatewayLogLevel
  readonly format: GatewayLogFormat
}

const SENSITIVE_HEADER = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|anthropic-api-key|chatgpt-account-id|cookie|set-cookie|x-gateway-(?:[^-]+-)?(?:access-token|refresh-token|token))$/i
const SENSITIVE_FIELD_PATHS = [
  'authorization',
  'proxy_authorization',
  'proxy-authorization',
  'x_api_key',
  'x-api-key',
  'x_goog_api_key',
  'x-goog-api-key',
  'anthropic-api-key',
  'cookie',
  'set_cookie',
  'set-cookie',
  'access_token',
  'refresh_token',
  'password',
  'secret',
  'headers.authorization',
  'headers.proxy-authorization',
  'headers.x-api-key',
  'headers.x-goog-api-key',
  'headers.anthropic-api-key',
  'headers.cookie',
  'headers.set-cookie',
] as const

export function parseGatewayLogLevel(raw: string | undefined): GatewayLogLevel {
  const value = raw ?? 'info'
  if ((GATEWAY_LOG_LEVELS as readonly string[]).includes(value)) return value as GatewayLogLevel
  throw new Error(
    `AGENT_GATEWAY_LOG_LEVEL must be one of ${GATEWAY_LOG_LEVELS.join('|')}; received ${JSON.stringify(value)}`,
  )
}

export function parseGatewayLogFormat(raw: string | undefined): GatewayLogFormat {
  const value = raw ?? 'text'
  if ((GATEWAY_LOG_FORMATS as readonly string[]).includes(value)) return value as GatewayLogFormat
  throw new Error(
    `AGENT_GATEWAY_LOG_FORMAT must be one of ${GATEWAY_LOG_FORMATS.join('|')}; received ${JSON.stringify(value)}`,
  )
}

export function gatewayLoggingSettingsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): GatewayLoggingSettings {
  return {
    level: parseGatewayLogLevel(environment.AGENT_GATEWAY_LOG_LEVEL),
    format: parseGatewayLogFormat(environment.AGENT_GATEWAY_LOG_FORMAT),
  }
}

function createGatewayLogDestination(format: GatewayLogFormat): DestinationStream {
  if (format === 'json') return pino.destination({ dest: 2, sync: false })
  return pinoPretty({
    colorize: Boolean(process.stderr.isTTY),
    destination: 2,
    singleLine: true,
    sync: true,
  })
}

/** Build a standard Pino logger. Tests can provide an in-memory destination. */
export function createGatewayLogger(
  settings: GatewayLoggingSettings = gatewayLoggingSettingsFromEnvironment(),
  destination: DestinationStream = createGatewayLogDestination(settings.format),
): GatewayLogger {
  return pino(
    {
      level: settings.level,
      base: { service: 'agent-gateway' },
      errorKey: 'error',
      serializers: { error: pino.stdSerializers.err },
      redact: { paths: [...SENSITIVE_FIELD_PATHS], censor: '[REDACTED]' },
    },
    destination,
  )
}

let traceSequence = 0
export function createGatewayTraceId(): string {
  traceSequence += 1
  return `gateway_${Date.now().toString(36)}_${traceSequence.toString(36)}`
}

export function createGatewayRequestLogger(
  logger: GatewayLogger,
  trace: string,
  context: Readonly<Record<string, unknown>> = {},
): GatewayLogger {
  return logger.child({ trace, ...context })
}

/** Redact headers before they cross a logging boundary, including custom request headers. */
export function redactGatewayHeaders(
  headers: Record<string, string> | Headers | undefined,
): Record<string, string> {
  if (!headers) return {}
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers)
  return Object.fromEntries(
    entries.map(([name, value]) => [name, SENSITIVE_HEADER.test(name) ? `[REDACTED:${String(value).length}]` : String(value)]),
  )
}

/** Every lossy IR conversion is a warning because it changes the caller's intent. */
export function logGatewayIRLosses(logger: GatewayLogger, losses: readonly IRLoss[] | undefined): void {
  for (const loss of losses ?? []) {
    logger.warn({ event: 'agent_ir.translation_loss', loss }, 'Agent IR translation lost requested semantics')
  }
}

/**
 * Split an upstream stream for parser and logger. Logging observes frames at trace level;
 * it never drains the parser branch or persists raw data.
 */
export function teeGatewaySseResponseForTraceLogging(
  logger: GatewayLogger,
  response: Response,
): Response {
  if (!response.body || !logger.isLevelEnabled('trace')) return response
  let loggingBranch: ReadableStream<Uint8Array>
  let parserBranch: ReadableStream<Uint8Array>
  try {
    ;[loggingBranch, parserBranch] = response.body.tee()
  } catch (error) {
    logger.warn({ event: 'outbox.sse_trace_unavailable', error }, 'Unable to split upstream SSE stream for trace logging')
    return response
  }
  void (async () => {
    try {
      const reader = loggingBranch.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sequence = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice('data:'.length).trim()
          if (!data || data === '[DONE]') continue
          sequence += 1
          logger.trace({ event: 'outbox.sse_frame', sequence, bytes: data.length }, 'Observed upstream SSE frame')
        }
      }
    } catch (error) {
      logger.warn({ event: 'outbox.sse_trace_failed', error }, 'Upstream SSE trace observer stopped')
    }
  })()
  return new Response(parserBranch, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
