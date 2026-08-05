import { expect, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import {
  createGatewayLogger,
  createGatewayRequestLogger,
  gatewayLoggingSettingsFromEnvironment,
  parseGatewayLogFormat,
  parseGatewayLogLevel,
  redactGatewayHeaders,
  summarizeOutboxScheduling,
  summarizeResponsesSchedulingEvent,
  type GatewayLogFormat,
} from '../src/logging.js'

function createCapturedJsonLogger(level: ReturnType<typeof parseGatewayLogLevel>) {
  const destination = new PassThrough()
  let output = ''
  destination.on('data', chunk => { output += chunk.toString() })
  const logger = createGatewayLogger({ level, format: 'json' }, destination)
  return {
    logger,
    read: (): Record<string, unknown>[] => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
  }
}

test('Pino honours the configured level and preserves request trace context', () => {
  const captured = createCapturedJsonLogger('info')
  const requestLogger = createGatewayRequestLogger(captured.logger, 'trace-log-test', { inbox: 'responses' })
  requestLogger.debug({ event: 'debug.hidden' }, 'debug should be filtered')
  requestLogger.info({ event: 'request.received' }, 'request accepted')

  expect(captured.read()).toEqual([
    expect.objectContaining({ trace: 'trace-log-test', inbox: 'responses', event: 'request.received', level: 30 }),
  ])
})

test('Pino redacts sensitive headers before emitting JSON logs', () => {
  const captured = createCapturedJsonLogger('trace')
  captured.logger.info(
    {
      event: 'outbox.request_compiled',
      headers: redactGatewayHeaders({
        authorization: 'Bearer secret-token',
        'x-api-key': 'another-secret',
        'anthropic-api-key': 'anthropic-secret',
      }),
    },
    'compiled request',
  )

  const line = JSON.stringify(captured.read()[0])
  expect(line).not.toContain('secret-token')
  expect(line).not.toContain('another-secret')
  expect(line).not.toContain('anthropic-secret')
  expect(line).toContain('[REDACTED')
})

test('logging configuration accepts only documented environment values', () => {
  expect(parseGatewayLogLevel('trace')).toBe('trace')
  expect(parseGatewayLogFormat('json')).toBe('json')
  expect(gatewayLoggingSettingsFromEnvironment({
    AGENT_GATEWAY_LOG_LEVEL: 'warn',
    AGENT_GATEWAY_LOG_FORMAT: 'text' as GatewayLogFormat,
  })).toEqual({ level: 'warn', format: 'text' })
  expect(() => parseGatewayLogLevel('verbose')).toThrow('AGENT_GATEWAY_LOG_LEVEL')
  expect(() => parseGatewayLogFormat('ndjson')).toThrow('AGENT_GATEWAY_LOG_FORMAT')
})

test('outbox scheduling audit omits prompt content and preserves service tier', () => {
  const audit = summarizeOutboxScheduling(JSON.stringify({
    model: 'gpt-5.6-terra',
    service_tier: 'priority',
    stream: true,
    input: 'private user prompt must never be logged',
  }))

  expect(audit).toEqual({ model: 'gpt-5.6-terra', serviceTier: 'priority', stream: true })
  expect(JSON.stringify(audit)).not.toContain('private user prompt')
  expect(summarizeOutboxScheduling(new Uint8Array([0xff]))).toBeUndefined()
})

test('Responses scheduling audit extracts only the response.created acknowledgement', () => {
  const event = summarizeResponsesSchedulingEvent(JSON.stringify({
    type: 'response.created',
    response: {
      model: 'gpt-5.6-terra', service_tier: 'priority', status: 'in_progress', output: 'must not be logged',
    },
  }))

  expect(event).toEqual({ model: 'gpt-5.6-terra', serviceTier: 'priority', status: 'in_progress' })
  expect(JSON.stringify(event)).not.toContain('must not be logged')
  expect(summarizeResponsesSchedulingEvent('{"type":"response.completed"}')).toBeUndefined()
})
