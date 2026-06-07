/**
 * Wire adapter facade
 */

import { AnthropicEventEmitter } from './emitter.js'
import { debugLog, extractRequestBody, shouldPassthrough } from './passthrough.js'
import { devlog, redactHeaders, teeForLog, newTrace } from './devlog.js'
import { compressImages } from './image_compress.js'
import type { WireProvider } from './types.js'
import { createOpenaiCompatProvider } from './providers/openai_compat_provider.js'
import { createCodexProvider } from './providers/codex_provider.js'
import { createAntigravityProvider, ANTIGRAVITY_DEFAULT_MODEL } from './providers/antigravity_provider.js'
import { createAnthropicPassthroughProvider } from './providers/anthropic_passthrough_provider.js'
import { detectLocalCredits } from './auth.js'

export interface PickProviderOpts {
  model?: string
  apiKey?: string
}

// Gateway-level model remap. Clients (e.g. claude-code) use a cheap "fast/background"
// model — claude-haiku-4-5 — for titles/summaries/小任务. Left alone it would route to the
// real Claude Haiku backend, both costing money and contaminating a pure-gemini eval. Map
// every haiku-class id to the cheapest gemini gear so background work runs on cheap gemini.
const MODEL_REMAP: Array<[RegExp, string]> = [[/haiku/i, 'gemini-3.5-flash-extra-low']]

export function remapModel(model: string | undefined): string {
  const m = model ?? ''
  for (const [re, target] of MODEL_REMAP) if (re.test(m)) return target
  return m
}

// Input-triggered gear escalation: when the user explicitly asks to think
// (writes 「思考」/「深思」/ultrathink/think hard), bump THIS request to the high gear.
// Default stays medium for stability+cost; the dynamic gear (gemini-3-flash, budget=-1)
// is avoided entirely — it runs away into thinking-repetition loops.
const HIGH_GEAR = 'gemini-3-flash-agent'
const THINK_TRIGGER = /思考|深思|think hard|ultrathink|think harder/i

export function resolveModel(
  model: string | undefined,
  userText: string,
): { model: string; escalated: boolean } {
  const m = remapModel(model)
  // 「思考」escalation lifts a LOWER flash gear to the high flash gear. It must never
  // touch a Pro pick (gemini-3.1-pro-*) — that's a bigger model, not a budget tier;
  // escalating it to a flash gear would be a DOWNGRADE.
  const isLowerFlashGear = /flash/i.test(m) && m !== HIGH_GEAR
  if (isLowerFlashGear && THINK_TRIGGER.test(userText)) {
    return { model: HIGH_GEAR, escalated: true }
  }
  return { model: m, escalated: false }
}

export function pickWireProvider(opts: PickProviderOpts): WireProvider | null {
  const truthy = (v: string | undefined): boolean =>
    !!v && !['0', 'false', 'no', ''].includes(v.toLowerCase())

  // 1. Anthropic passthrough
  if (truthy(process.env.CLAUDE_CODE_USE_CUSTOM_ANTHROPIC)) {
    return createAnthropicPassthroughProvider({
      baseURL: process.env.CUSTOM_ANTHROPIC_BASE_URL ?? '',
      apiKey: process.env.CUSTOM_ANTHROPIC_API_KEY ?? opts.apiKey ?? '',
      model: process.env.CUSTOM_ANTHROPIC_MODEL ?? opts.model ?? '',
    })
  }

  // 2. Antigravity / Gemini OAuth
  const modelLower = opts.model?.toLowerCase() ?? ''
  if (truthy(process.env.CLAUDE_CODE_USE_ANTIGRAVITY) || modelLower.includes('gemini')) {
    return createAntigravityProvider({
      model: process.env.ANTIGRAVITY_MODEL ?? opts.model ?? ANTIGRAVITY_DEFAULT_MODEL,
    })
  }

  // 2.5 Claude (Anthropic API / OAuth)
  if (modelLower.includes('claude') || process.env.ANTHROPIC_API_KEY) {
    const credits = detectLocalCredits()
    const claudeCredit = credits.find(c => c.provider === 'claude')
    if (claudeCredit) {
      if (claudeCredit.type === 'oauth' && claudeCredit.source) {
        return createAnthropicPassthroughProvider({
          baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
          apiKey: '',
          source: claudeCredit.source,
          model: opts.model ?? 'claude-3-7-sonnet',
        })
      } else if (claudeCredit.type === 'api_key' && claudeCredit.value) {
        return createAnthropicPassthroughProvider({
          baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
          apiKey: claudeCredit.value,
          model: opts.model ?? 'claude-3-7-sonnet',
        })
      }
    }
  }

  // 3. Codex (ChatGPT subscriber)
  const credits = detectLocalCredits()
  const codexCredit = credits.find(c => c.provider === 'codex')
  if (codexCredit) {
    if (codexCredit.type === 'oauth' && codexCredit.source) {
      return createCodexProvider({ source: codexCredit.source })
    }
  }

  // 4. Gemini via OpenAI compat
  if (truthy(process.env.CLAUDE_CODE_USE_GEMINI) || truthy(process.env.CLAUDE_CODE_USE_GOOGLE)) {
    const geminiCredit = credits.find(c => c.provider === 'gemini')
    return createOpenaiCompatProvider({
      baseURL:
        process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: process.env.GEMINI_API_KEY ?? geminiCredit?.value ?? '',
      model: process.env.GEMINI_MODEL ?? opts.model ?? 'gemini-2.5-flash',
    })
  }

  // 5. OpenAI / OpenAI-Compat
  if (
    truthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    truthy(process.env.CLAUDE_CODE_USE_OPENAI_COMPAT) ||
    modelLower.includes('gpt-') || modelLower.includes('o1-') || modelLower.includes('o3-')
  ) {
    const codexCredit = credits.find(c => c.provider === 'codex')
    const apiKey = process.env.OPENAI_API_KEY ?? opts.apiKey ?? (codexCredit?.type === 'api_key' ? codexCredit.value : '') ?? ''
    return createOpenaiCompatProvider({
      baseURL: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: apiKey,
      model: process.env.OPENAI_MODEL ?? process.env.OPENAI_COMPAT_MODEL ?? opts.model ?? 'gpt-4o',
    })
  }

  return null
}

export function createWireAdapter(
  provider: WireProvider,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (shouldPassthrough(input)) {
      return globalThis.fetch(input as any, init)
    }

    const t0 = performance.now()
    const reqHeaders = (init?.headers as Record<string, string> | undefined) ?? {}
    const trace = reqHeaders['x-dev-trace'] ?? reqHeaders['X-Dev-Trace'] ?? newTrace()
    const anthropicReq = await extractRequestBody(init)
    // Shrink oversized images before they reach any provider (size-sensitive backends).
    await compressImages(anthropicReq, trace)
    debugLog(provider.name, { route: 'request', model: anthropicReq.model })
    devlog(trace, 'decoded_ir', {
      provider: provider.name,
      model: anthropicReq.model,
      messageCount: anthropicReq.messages?.length ?? 0,
      toolCount: anthropicReq.tools?.length ?? 0,
      request: anthropicReq,
    })

    try {
      await provider.prepare?.()
    } catch (err: any) {
      devlog(trace, 'error', { provider: provider.name, at: 'prepare', message: String(err?.message ?? err) })
      return errorResponse(502, `wire ${provider.name} prepare failed: ${err?.message ?? err}`)
    }

    let prepared: Awaited<ReturnType<typeof provider.buildRequest>>
    try {
      prepared = await provider.buildRequest(anthropicReq)
    } catch (err: any) {
      devlog(trace, 'error', { provider: provider.name, at: 'buildRequest', message: String(err?.message ?? err) })
      return errorResponse(500, `wire ${provider.name} buildRequest failed: ${err?.message ?? err}`)
    }
    devlog(trace, 'upstream_request', {
      provider: provider.name,
      url: prepared.url,
      headers: redactHeaders(prepared.headers),
      body: safeParseJSON(prepared.body),
    })

    let upstream: Response
    try {
      upstream = await globalThis.fetch(prepared.url, {
        method: 'POST',
        headers: prepared.headers,
        body: prepared.body,
      })
    } catch (err: any) {
      devlog(trace, 'error', { provider: provider.name, at: 'fetch', message: String(err?.message ?? err) })
      return errorResponse(502, `wire ${provider.name} upstream fetch failed: ${err?.message ?? err}`)
    }

    devlog(trace, 'upstream_status', {
      provider: provider.name,
      status: upstream.status,
      headers: redactHeaders(upstream.headers),
    })

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '')
      devlog(trace, 'error', { provider: provider.name, at: 'upstream', status: upstream.status, body: text.slice(0, 4000) })
      return errorResponse(upstream.status, `wire ${provider.name} upstream ${upstream.status}: ${text}`)
    }

    // Buffered collect + retry: parse each upstream attempt fully into an emitter; if the
    // turn collapsed (unusable — e.g. MALFORMED_FUNCTION_CALL with no content), re-issue up
    // to MAX_ATTEMPTS before responding. Trades live token streaming for fault tolerance —
    // agent tool-turns are short, and a recovered turn beats a silent-empty one.
    const encoder = new TextEncoder()
    const messageId = `msg_wire_${Date.now().toString(36)}`
    const MAX_ATTEMPTS = 3

    let finalEmitter = new AnthropicEventEmitter()
    let attemptResp: Response | null = upstream
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        devlog(trace, 'retry', { provider: provider.name, attempt, reason: 'unusable_upstream' })
        try {
          attemptResp = await globalThis.fetch(prepared.url, {
            method: 'POST',
            headers: prepared.headers,
            body: prepared.body,
          })
        } catch (err: any) {
          devlog(trace, 'error', { at: 'retry_fetch', attempt, message: String(err?.message ?? err) })
          break
        }
        if (!attemptResp.ok) {
          const t = await attemptResp.text().catch(() => '')
          devlog(trace, 'error', { at: 'retry_upstream', attempt, status: attemptResp.status, body: t.slice(0, 2000) })
          break
        }
      }
      const logged = teeForLog(trace, 'upstream_sse', attemptResp)
      const em = new AnthropicEventEmitter()
      try {
        await provider.parseStream(logged, em)
      } catch (err: any) {
        em.error(err)
      } finally {
        if (!em['finished' as keyof typeof em]) {
          try { em.finish() } catch {}
        }
      }
      finalEmitter = em
      if (!em.isUnusable()) break
    }

    const usage = finalEmitter.getUsage()
    devlog(trace, 'done', {
      provider: provider.name,
      durationMs: Math.round(performance.now() - t0),
      toolUseCount: finalEmitter.getToolUseCount(),
      usage,
      unusable: finalEmitter.isUnusable(),
    })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of finalEmitter.drain()) {
          devlog(trace, 'outbound_sse', { raw: chunk.trim() })
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'x-request-id': messageId,
      },
    })
  }
}

function safeParseJSON(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}
