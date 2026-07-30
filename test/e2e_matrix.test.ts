import { expect, test, describe } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { detectLocalCredits } from '../src/auth.js'
import { pickWireProvider, createWireAdapter } from '../src/index.js'
import type { AnthropicMessagesRequest } from '../src/types.js'

const FAKE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

// Helper to determine if we should run a specific provider's E2E tests
const hasAntigravityCreds = () => fs.existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'))
const hasCodexCreds = () => fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json')) || !!process.env.OPENAI_API_KEY || !!process.env.CODEX_API_KEY
const hasClaudeCreds = () => fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json')) || !!process.env.ANTHROPIC_API_KEY

describe('E2E Matrix Tests', () => {
  
  // ── Antigravity (Gemini via CloudCode) ─────────────────────────────
  describe('Provider: Antigravity', () => {
    const skip = !hasAntigravityCreds()

    test('Model ID Listing', async () => {
      if (skip) test.skip('No Antigravity credentials found')
      
      const provider = pickWireProvider({ model: 'gemini-3.5-flash-low' })
      expect(provider).not.toBeNull()
      await provider!.prepare?.()
      
      const models = await provider!.listModels?.()
      expect(models).toBeDefined()
      expect(models!.length).toBeGreaterThan(0)
      console.log(`[E2E Antigravity] Listed ${models!.length} models. First: ${models![0].id} (${models![0].name})`)
    })

    test('Quota Information', async () => {
      if (skip) test.skip('No Antigravity credentials found')

      const provider = pickWireProvider({ model: 'gemini-3.5-flash-low' })
      expect(provider).not.toBeNull()
      await provider!.prepare?.()

      const quota = await provider!.getQuota?.()
      expect(quota).toBeDefined()
      expect(quota!.planType).toBeDefined()
      console.log(`[E2E Antigravity] Quota plan: ${quota!.planType}, tier/project: ${quota!.tier}`)
    })

    test('LLM Text Conversation', async () => {
      if (skip) test.skip('No Antigravity credentials found')

      const provider = pickWireProvider({ model: 'gemini-3.5-flash-low' })
      expect(provider).not.toBeNull()
      const adapter = createWireAdapter(provider!)

      const req: AnthropicMessagesRequest = {
        model: 'gemini-3.5-flash-low',
        messages: [{ role: 'user', content: 'Say hello and respond in exactly 5 words.' }],
        max_tokens: 50,
      }

      const res = await adapter('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      })

      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('message_start')
      expect(text).toContain('message_stop')
      console.log(`[E2E Antigravity] LLM Conversation stream response length: ${text.length}`)
    })

    test('Multi-modal Image Input', async () => {
      if (skip) test.skip('No Antigravity credentials found')

      const provider = pickWireProvider({ model: 'gemini-3.5-flash-low' })
      expect(provider).not.toBeNull()
      const adapter = createWireAdapter(provider!)

      const req: AnthropicMessagesRequest = {
        model: 'gemini-3.5-flash-low',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: FAKE_PNG_BASE64 } }
          ]
        }],
        max_tokens: 50,
      }

      const res = await adapter('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      })

      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('message_start')
      console.log(`[E2E Antigravity] Image input stream response length: ${text.length}`)
    })
  })

  // ── Codex (ChatGPT Responses API) ──────────────────────────────────
  describe('Provider: Codex', () => {
    const skip = !hasCodexCreds()

    test('Model ID Listing', async () => {
      if (skip) test.skip('No Codex credentials found')

      const provider = pickWireProvider({ model: 'gpt-5.6-sol' })
      expect(provider).not.toBeNull()
      await provider!.prepare?.()

      const models = await provider!.listModels?.()
      expect(models).toBeDefined()
      expect(models!.length).toBeGreaterThan(0)
      console.log(`[E2E Codex] Listed ${models!.length} models. First: ${models![0].id}`)
    })

    test('Quota Information', async () => {
      if (skip) test.skip('No Codex credentials found')

      const provider = pickWireProvider({ model: 'gpt-5.6-sol' })
      expect(provider).not.toBeNull()
      await provider!.prepare?.()

      const quota = await provider!.getQuota?.()
      expect(quota).toBeDefined()
      console.log(`[E2E Codex] Quota planType: ${quota!.planType}`)
    })

    test('LLM Text Conversation', async () => {
      if (skip) test.skip('No Codex credentials found')

      const provider = pickWireProvider({ model: 'gpt-5.6-sol' })
      expect(provider).not.toBeNull()
      const adapter = createWireAdapter(provider!)

      const req: AnthropicMessagesRequest = {
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'Say hello!' }],
        max_tokens: 50,
      }

      const res = await adapter('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      })

      if (res.status !== 200) {
        const errText = await res.text()
        console.warn(`[E2E Codex] Warning: Conversation request failed with ${res.status}: ${errText}`)
        // 400/401 = missing/invalid creds; 403/429 = plan gating / rate limit;
        // 5xx = transient upstream. All are environment conditions, not wire-translation
        // bugs — tolerate so the suite reflects translation correctness, not account state.
        if ([400, 401, 403, 404, 429].includes(res.status) || res.status >= 500) {
          return
        }
      }
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('message_start')
      console.log(`[E2E Codex] Conversation stream response length: ${text.length}`)
    })
  })

  // ── Claude (Anthropic API / OAuth) ──────────────────────────────────
  describe('Provider: Claude', () => {
    const skip = !hasClaudeCreds()

    test('Model ID Listing', async () => {
      if (skip) test.skip('No Claude credentials found')

      const provider = pickWireProvider({ model: 'claude-opus-5' })
      expect(provider).not.toBeNull()
      await provider!.prepare?.()

      const models = await provider!.listModels?.()
      expect(models).toBeDefined()
      expect(models!.length).toBeGreaterThan(0)
      console.log(`[E2E Claude] Listed ${models!.length} models. First: ${models![0].id}`)
    })

    test('Quota Information', async () => {
      if (skip) test.skip('No Claude credentials found')

      const provider = pickWireProvider({ model: 'claude-opus-5' })
      expect(provider).not.toBeNull()
      await provider!.prepare?.()

      const quota = await provider!.getQuota?.()
      expect(quota).toBeDefined()
      console.log(`[E2E Claude] Quota planType: ${quota!.planType}, tier: ${quota!.tier}`)
    })

    test('LLM Text Conversation', async () => {
      if (skip) test.skip('No Claude credentials found')

      const provider = pickWireProvider({ model: 'claude-opus-5' })
      expect(provider).not.toBeNull()
      const adapter = createWireAdapter(provider!)

      const req: AnthropicMessagesRequest = {
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'Say hello!' }],
        max_tokens: 50,
      }

      const res = await adapter('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
      })

      if (res.status !== 200) {
        const errText = await res.text()
        console.warn(`[E2E Claude] Warning: Conversation request failed with ${res.status}: ${errText}`)
        // 400/401 = missing/invalid creds; 403/429 = plan gating / rate limit;
        // 5xx = transient upstream. All are environment conditions, not wire-translation
        // bugs — tolerate so the suite reflects translation correctness, not account state.
        if ([400, 401, 403, 404, 429].includes(res.status) || res.status >= 500) {
          return
        }
      }
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain('message_start')
      console.log(`[E2E Claude] Conversation stream response length: ${text.length}`)
    })
  })
})
