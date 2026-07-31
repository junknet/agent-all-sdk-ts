/**
 * Full-fidelity dev logging for the gateway, persisted as NDJSON to disk.
 *
 * One trace id per inbound request stitches every phase together:
 *   inbound → decoded_ir → upstream_request → upstream_status → upstream_sse(raw vendor)
 *   → outbound_sse(anthropic IR) → outbound_responses(re-encoded) → done/error.
 *
 * "全量" = every field is logged, EXCEPT: auth headers are redacted (length only) and
 * base64 image payloads are collapsed to `[image N chars]` so a single screenshot does
 * not bloat the log into the megabytes. Everything else (tool schemas, tool_use args,
 * function_call_output, reasoning, usage) is written verbatim — these are exactly the
 * round-trip fields that break (tool_use / parallel / subagent / compaction).
 *
 * Enabled when AGENT_GATEWAY_DEVLOG is truthy (default ON in the supervisor dev unit).
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR =
  process.env.AGENT_GATEWAY_LOG_DIR ??
  process.env.AGENT_GATEWAY_DUMP_DIR ??
  '<traffic-logs>'

const ENABLED = (() => {
  const v = process.env.AGENT_GATEWAY_DEVLOG
  if (v === undefined) return true // dev gateway: on by default
  return !['0', 'false', 'no', ''].includes(v.toLowerCase())
})()

let ready = false
function ensureDir(): void {
  if (ready) return
  try {
    mkdirSync(LOG_DIR, { recursive: true })
  } catch {}
  ready = true
}

let seq = 0
export function newTrace(): string {
  seq += 1
  return `tr_${Date.now().toString(36)}_${seq.toString(36)}`
}

// Per-trace metadata (harness identity, session id, model) — set once at inbound and
// merged into EVERY subsequent log line for that trace, so logs group cleanly by
// harness×session×model for the two-axis (model capability vs harness capability) eval.
const traceMeta = new Map<string, Record<string, unknown>>()
export function setTraceMeta(trace: string, meta: Record<string, unknown>): void {
  traceMeta.set(trace, meta)
  // bound memory: drop oldest when the map grows unreasonably (long-lived daemon)
  if (traceMeta.size > 4096) {
    const firstKey = traceMeta.keys().next().value
    if (firstKey !== undefined) traceMeta.delete(firstKey)
  }
}

function logFilePath(): string {
  const d = new Date()
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return join(LOG_DIR, `gateway-dev-${day}.ndjson`)
}

const REDACT_HEADER = /^(authorization|x-api-key|x-goog-api-key|chatgpt-account-id|cookie|set-cookie)$/i

export function redactHeaders(h: Record<string, string> | Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h)
  for (const [k, v] of entries) {
    out[k] = REDACT_HEADER.test(k) ? `[redacted:${String(v).length}]` : String(v)
  }
  return out
}

// Collapse large base64 blobs (image data / data: URLs) to a size marker.
function sanitize(obj: unknown, depth = 0): unknown {
  if (depth > 16 || obj === null || obj === undefined) return obj
  if (typeof obj === 'string') {
    if (obj.length > 2048 && (obj.startsWith('data:') || /^[A-Za-z0-9+/=\n\r]+$/.test(obj.slice(0, 80)))) {
      return `[b64 ${obj.length} chars]`
    }
    return obj
  }
  if (Array.isArray(obj)) return obj.map(x => sanitize(x, depth + 1))
  if (typeof obj === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if ((k === 'data' || k === 'image_url') && typeof v === 'string' && v.length > 256) {
        out[k] = `[image ${v.length} chars]`
      } else {
        out[k] = sanitize(v, depth + 1)
      }
    }
    return out
  }
  return obj
}

// 单条记录上限。sanitize 只折叠了 base64 大块，request/response 的 messages 与
// tools 仍然整体落盘 —— 实测单条最大 69KB、单日 37753 条共 990MB，且只增不减。
// 超限时保留可检索的头部并标注截断量，诊断需要的 trace/phase/model 都在前面。
const MAX_RECORD_BYTES = (() => {
  const v = Number(process.env.AGENT_GATEWAY_DEVLOG_MAX_RECORD)
  return Number.isFinite(v) && v > 0 ? v : 8192
})()

export function devlog(trace: string, phase: string, data: Record<string, unknown>): void {
  if (!ENABLED) return
  ensureDir()
  const meta = traceMeta.get(trace) ?? {}
  const record = { ts: new Date().toISOString(), trace, ...meta, phase, ...(sanitize(data) as Record<string, unknown>) }
  try {
    let line = JSON.stringify(record)
    if (line.length > MAX_RECORD_BYTES) {
      const dropped = line.length - MAX_RECORD_BYTES
      line =
        line.slice(0, MAX_RECORD_BYTES) +
        `…"__truncated_bytes":${dropped}}`
    }
    appendFileSync(logFilePath(), line + '\n')
  } catch {}
}

/**
 * Tee a streaming Response for logging: returns a fresh Response identical to the input
 * while draining a clone into the dev log line-by-line (raw vendor SSE). Non-blocking —
 * the clone is read in the background and never gates the real consumer.
 */
export function teeForLog(trace: string, phase: string, response: Response): Response {
  if (!ENABLED || !response.body) return response
  let clone: Response
  try {
    clone = response.clone()
  } catch {
    return response
  }
  void (async () => {
    try {
      const reader = clone.body!.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      let n = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, '')
          buf = buf.slice(nl + 1)
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim()
            if (payload && payload !== '[DONE]') {
              n += 1
              devlog(trace, phase, { seq: n, raw: sanitize(safeParse(payload)) })
            }
          }
        }
      }
    } catch (err: any) {
      devlog(trace, phase, { error: String(err?.message ?? err) })
    }
  })()
  return response
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
