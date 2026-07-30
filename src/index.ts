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
import { detectLocalCredits, type CustomTokens } from './auth.js'

export interface PickProviderOpts {
  model?: string
  apiKey?: string
  customTokens?: CustomTokens
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

// Extract ONLY the latest human-authored user turn from an inbound request (any protocol),
// for the 「思考」 escalation trigger. This makes escalation a per-input STATE MACHINE, not a
// sticky-forever flag: a tool-loop continuation request carries no new human turn (its last
// user message is a tool_result), so the latest human turn stays the same and 「思考」 keeps
// holding across the whole agent loop — then the NEXT human input redefines the state (no
// 「思考」 → back to base). Scanning all historical user messages (the old behaviour) made one
// 「思考」 anywhere in context escalate forever; tool_result/assistant/system are never input.
export function latestUserInput(body: any): string {
  // A human turn has real input blocks; a tool_result continuation has only tool_result.
  const isHumanTurn = (c: any): boolean =>
    typeof c === 'string'
      ? c.length > 0
      : Array.isArray(c)
        ? c.some((b: any) => b?.type !== 'tool_result')
        : false
  // Concatenate the turn's text blocks (anthropic `text`, codex `input_text`); skip tool_result.
  const textOf = (c: any): string =>
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c
            .filter((b: any) => typeof b?.text === 'string' && b.type !== 'tool_result')
            .map((b: any) => b.text)
            .join('\n')
        : ''

  // anthropic /v1/messages + openai /v1/chat: newest user message that is a human turn.
  // (Anthropic tool_result is role 'user' → skipped via isHumanTurn; OpenAI tool results are
  //  role 'tool' → skipped via the role check.)
  if (Array.isArray(body?.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      const m = body.messages[i]
      if (m?.role !== 'user' || !isHumanTurn(m.content)) continue
      return textOf(m.content)
    }
  }
  // codex /v1/responses input[]: newest user message item (skip function_call_output tool results).
  if (Array.isArray(body?.input)) {
    for (let i = body.input.length - 1; i >= 0; i--) {
      const it = body.input[i]
      if (typeof it === 'string') return it
      if (it?.type === 'message' && it.role === 'user') return textOf(it.content)
    }
  }
  return ''
}

export function pickWireProvider(opts: PickProviderOpts): WireProvider | null {
  const truthy = (v: string | undefined): boolean =>
    !!v && !['0', 'false', 'no', ''].includes(v.toLowerCase())

  const credits = detectLocalCredits(opts)

  // 0. 单后端强制出口：锁定到指定 OpenAI 兼容后端（自部署 vLLM 等），绕过按 model
  //    分流 / gemini 评测路由 / 本地凭据探测。用于「三协议统一入口 → 单一模型」部署，
  //    任何入口协议、任何 model 名都落到同一后端；实际 model 由 OPENAI_MODEL 固定。
  if (truthy(process.env.FORCE_OPENAI_COMPAT)) {
    return createOpenaiCompatProvider({
      baseURL: process.env.OPENAI_BASE_URL ?? '',
      apiKey: process.env.OPENAI_API_KEY ?? opts.apiKey ?? '',
      model: process.env.OPENAI_MODEL ?? process.env.OPENAI_COMPAT_MODEL ?? opts.model ?? '',
    })
  }

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
    const geminiCredit = credits.find(c => c.provider === 'gemini')
    return createAntigravityProvider({
      model: process.env.ANTIGRAVITY_MODEL ?? opts.model ?? ANTIGRAVITY_DEFAULT_MODEL,
      source: geminiCredit?.type === 'oauth' ? geminiCredit.source : undefined,
    })
  }

  // 2.5 Claude (Anthropic API / OAuth)
  if (modelLower.includes('claude') || process.env.ANTHROPIC_API_KEY) {
    const claudeCredit = credits.find(c => c.provider === 'claude')
    if (claudeCredit) {
      if (claudeCredit.type === 'oauth' && claudeCredit.source) {
        return createAnthropicPassthroughProvider({
          baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
          apiKey: '',
          source: claudeCredit.source,
          model: opts.model ?? 'claude-opus-5',
        })
      } else if (claudeCredit.type === 'api_key' && claudeCredit.value) {
        return createAnthropicPassthroughProvider({
          baseURL: process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
          apiKey: claudeCredit.value,
          model: opts.model ?? 'claude-opus-5',
        })
      }
    }
  }

  // 3. Codex (ChatGPT subscriber)
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
      model: process.env.GEMINI_MODEL ?? opts.model ?? 'gemini-3.6-flash',
    })
  }

  // 5. OpenAI / OpenAI-Compat
  if (
    truthy(process.env.CLAUDE_CODE_USE_OPENAI) ||
    truthy(process.env.CLAUDE_CODE_USE_OPENAI_COMPAT) ||
    modelLower.includes('gpt-') || modelLower.includes('o1-') || modelLower.includes('o3-')
  ) {
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
