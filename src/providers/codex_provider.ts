/**
 * Codex provider (OpenAI Responses API, ChatGPT backend)
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
  WireProvider,
  WirePreparedRequest,
  ModelInfo,
  QuotaInfo,
} from '../types.js'
import type { AnthropicEventEmitter } from '../emitter.js'
import { iterSSE, tryParseJSON } from '../sse.js'
import type { TokenSource } from '../auth.js'

export const CODEX_MODELS = [
  { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', description: 'Frontier agentic coding model' },
  { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Codex coding model' },
  { id: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini', description: 'Fast Codex model' },
  { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', description: 'Max Codex model' },
  { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Latest GPT' },
  { id: 'gpt-5.2', label: 'GPT-5.2', description: 'GPT-5.2' },
] as const

export const DEFAULT_CODEX_MODEL = 'gpt-5.2-codex'

export function isCodexModel(model: string): boolean {
  return CODEX_MODELS.some(m => m.id === model)
}

export function mapClaudeModelToCodex(claudeModel: string | null): string {
  if (!claudeModel) return DEFAULT_CODEX_MODEL
  if (isCodexModel(claudeModel)) return claudeModel
  const lower = claudeModel.toLowerCase()
  if (lower.includes('opus')) return 'gpt-5.1-codex-max'
  if (lower.includes('haiku')) return 'gpt-5.1-codex-mini'
  if (lower.includes('sonnet')) return 'gpt-5.2-codex'
  return DEFAULT_CODEX_MODEL
}

const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

function extractAccountId(token: string): string {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid Codex JWT (expected 3 parts)')
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64').toString('utf-8'))
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
  if (!accountId) throw new Error('Codex JWT missing chatgpt_account_id claim')
  return String(accountId)
}

const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses'

export interface CodexOpts {
  accessToken?: string
  source?: TokenSource
}

export function createCodexProvider(opts: CodexOpts): WireProvider {
  let accessToken = opts.accessToken || ''
  let accountId = ''
  let codexModelCache = DEFAULT_CODEX_MODEL

  return {
    name: 'codex',

    async prepare(): Promise<void> {
      if (opts.source) {
        accessToken = await opts.source.token()
      }
      accountId = extractAccountId(accessToken)
    },

    async buildRequest(req: AnthropicMessagesRequest): Promise<WirePreparedRequest> {
      const codexModel = mapClaudeModelToCodex(req.model ?? null)
      codexModelCache = codexModel
      const instructions = systemPromptToString(req.system)
      const input = translateMessages(req.messages)

      const body: Record<string, unknown> = {
        model: codexModel,
        store: false,
        stream: true,
        instructions,
        input,
        tool_choice: tool_choice_to_codex(req.tool_choice),
        parallel_tool_calls: true,
      }
      if (req.tools && req.tools.length > 0) body.tools = translateTools(req.tools)
      if (req.max_tokens) body.max_output_tokens = req.max_tokens
      if (req.thinking?.type === 'enabled' && req.thinking.budget_tokens) {
        const tokens = req.thinking.budget_tokens
        const effort = tokens <= 1024 ? 'low' : tokens <= 4096 ? 'medium' : 'high'
        body.reasoning = { effort }
      }

      return {
        url: CODEX_ENDPOINT,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
          originator: 'pi',
          'OpenAI-Beta': 'responses=experimental',
        },
        body: JSON.stringify(body),
      }
    },

    async parseStream(response: Response, emitter: AnthropicEventEmitter): Promise<void> {
      emitter.start({ model: codexModelCache })
      let hadTools = false
      let fallbackToolCounter = 0
      const toolCalls = new Map<string, { order: number; id: string; name: string; arguments: string }>()
      const toolKeyByOutputIndex = new Map<number, string>()

      const resolveToolKey = (data: any): string => {
        if (typeof data.item_id === 'string' && data.item_id.length > 0) return data.item_id
        if (typeof data.output_index === 'number') {
          const existing = toolKeyByOutputIndex.get(data.output_index)
          if (existing) return existing
          const generated = `output_${data.output_index}`
          toolKeyByOutputIndex.set(data.output_index, generated)
          return generated
        }
        if (typeof data.call_id === 'string' && data.call_id.length > 0) return data.call_id
        return `tool_${fallbackToolCounter++}`
      }

      const upsertToolCall = (
        key: string,
        patch: { outputIndex?: number; callId?: string; name?: string; argumentsDelta?: string; argumentsFull?: string },
      ): void => {
        const current = toolCalls.get(key) ?? {
          order: typeof patch.outputIndex === 'number' ? patch.outputIndex : toolCalls.size,
          id: patch.callId || `call_${toolCalls.size}_${Date.now().toString(36)}`,
          name: patch.name || '',
          arguments: '',
        }
        if (typeof patch.outputIndex === 'number') current.order = patch.outputIndex
        if (patch.callId) current.id = patch.callId
        if (patch.name) current.name = patch.name
        if (typeof patch.argumentsFull === 'string') current.arguments = patch.argumentsFull
        if (typeof patch.argumentsDelta === 'string') current.arguments += patch.argumentsDelta
        toolCalls.set(key, current)
      }

      const emitBufferedToolCalls = (): void => {
        if (toolCalls.size === 0) return
        const sorted = [...toolCalls.values()].sort((left, right) => left.order - right.order)
        for (const tool of sorted) {
          if (!tool.id || !tool.name) continue
          emitter.openToolUse(tool.id, tool.name)
          if (tool.arguments.length > 0) emitter.pushToolArgsDelta(tool.arguments)
          emitter.closeBlock()
        }
        toolCalls.clear()
        toolKeyByOutputIndex.clear()
      }

      for await (const evt of iterSSE(response)) {
        const data = tryParseJSON<any>(evt.data)
        if (!data) continue
        const t = data.type as string

        switch (t) {
          case 'response.output_item.added': {
            const item = data.item
            if (item?.type === 'function_call') {
              hadTools = true
              const outputIndex = typeof data.output_index === 'number' ? data.output_index : undefined
              const key = typeof item.id === 'string' && item.id.length > 0
                ? item.id
                : resolveToolKey({ ...data, call_id: item.call_id })
              if (typeof outputIndex === 'number') toolKeyByOutputIndex.set(outputIndex, key)
              upsertToolCall(key, {
                outputIndex,
                callId: item.call_id,
                name: item.name,
                argumentsDelta: typeof item.arguments === 'string' ? item.arguments : undefined,
              })
            }
            break
          }
          case 'response.output_text.delta': {
            const text = data.delta as string | undefined
            if (typeof text === 'string' && text.length > 0) {
              emitter.pushText(text)
              emitter.addOutputTokens(1)
            }
            break
          }
          case 'response.reasoning.delta':
          case 'response.reasoning_summary_text.delta': {
            const text = (data.delta ?? data.text) as string | undefined
            if (typeof text === 'string' && text.length > 0) {
              emitter.pushThinking(text)
              emitter.addOutputTokens(1)
            }
            break
          }
          case 'response.function_call_arguments.delta': {
            const delta = data.delta as string | undefined
            if (typeof delta === 'string' && delta.length > 0) {
              hadTools = true
              const outputIndex = typeof data.output_index === 'number' ? data.output_index : undefined
              upsertToolCall(resolveToolKey(data), {
                outputIndex,
                callId: data.call_id,
                name: data.name,
                argumentsDelta: delta,
              })
            }
            break
          }
          case 'response.function_call_arguments.done': {
            hadTools = true
            const outputIndex = typeof data.output_index === 'number' ? data.output_index : undefined
            upsertToolCall(resolveToolKey(data), {
              outputIndex,
              callId: data.call_id,
              name: data.name,
              argumentsFull: typeof data.arguments === 'string' ? data.arguments : undefined,
            })
            break
          }
          case 'response.output_item.done': {
            const item = data.item
            if (item?.type === 'function_call') {
              hadTools = true
              const outputIndex = typeof data.output_index === 'number' ? data.output_index : undefined
              const key = typeof item.id === 'string' && item.id.length > 0
                ? item.id
                : resolveToolKey({ ...data, call_id: item.call_id })
              if (typeof outputIndex === 'number') toolKeyByOutputIndex.set(outputIndex, key)
              upsertToolCall(key, {
                outputIndex,
                callId: item.call_id,
                name: item.name,
                argumentsFull: typeof item.arguments === 'string' ? item.arguments : undefined,
              })
            } else {
              emitter.closeBlock()
            }
            break
          }
          case 'response.completed': {
            const usage = data.response?.usage
            if (usage) {
              emitter.setUsage({
                input: usage.input_tokens,
                output: usage.output_tokens,
              })
            }
            break
          }
        }
      }

      if (hadTools) emitBufferedToolCalls()
      emitter.setStopReason(hadTools ? 'tool_use' : 'end_turn')
      emitter.finish()
    },

    async listModels(): Promise<ModelInfo[]> {
      const res = await fetch('https://chatgpt.com/backend-api/codex/models', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'chatgpt-account-id': accountId,
          'OpenAI-Beta': 'responses=experimental',
        },
      })
      if (!res.ok) {
        return CODEX_MODELS.map(m => ({
          id: m.id,
          name: m.label,
        }))
      }
      const data = (await res.json()) as any
      const list = data.models || []
      return list.map((m: any) => ({
        id: m.slug || m.id,
        name: m.display_name || m.slug || m.id,
      }))
    },

    async getQuota(): Promise<QuotaInfo> {
      if (opts.source && opts.source.getQuota) {
        return opts.source.getQuota()
      }
      return {
        planType: 'codex-free',
      }
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function systemPromptToString(system: AnthropicMessagesRequest['system']): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text!)
    .join('\n')
}

function tool_choice_to_codex(
  choice: AnthropicMessagesRequest['tool_choice'],
): string | Record<string, unknown> {
  if (!choice) return 'auto'
  if (choice.type === 'any') return 'required'
  if (choice.type === 'none') return 'none'
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', name: choice.name }
  }
  return 'auto'
}

function translateTools(tools: AnthropicTool[]): Array<Record<string, unknown>> {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description ?? '',
    parameters: t.input_schema ?? { type: 'object', properties: {} },
    strict: null,
  }))
}

function translateMessages(
  messages: AnthropicMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  let counter = 0

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content })
      continue
    }
    if (!Array.isArray(msg.content)) continue

    if (msg.role === 'user') {
      const parts: Array<Record<string, unknown>> = []
      for (const block of msg.content as AnthropicContentBlock[]) {
        if (block.type === 'tool_result') {
          const callId = block.tool_use_id ?? `call_${counter++}`
          let outputText = ''
          if (typeof block.content === 'string') {
            outputText = block.content
          } else if (Array.isArray(block.content)) {
            outputText = block.content
              .map(c => {
                if (c.type === 'text') return c.text ?? ''
                if (c.type === 'image' && c.source && c.source.type === 'base64') {
                  return `![image](data:${c.source.media_type};base64,${c.source.data})`
                }
                return ''
              })
              .filter(Boolean)
              .join('\n')
          }
          out.push({ type: 'function_call_output', call_id: callId, output: outputText })
        } else if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'input_text', text: block.text })
        } else if (
          block.type === 'image' &&
          block.source &&
          (block.source as any).type === 'base64'
        ) {
          const src = block.source as any
          parts.push({
            type: 'input_image',
            image_url: `data:${src.media_type};base64,${src.data}`,
          })
        }
      }
      if (parts.length === 1 && parts[0]!.type === 'input_text') {
        out.push({ role: 'user', content: parts[0]!.text })
      } else if (parts.length > 0) {
        out.push({ role: 'user', content: parts })
      }
    } else {
      // assistant
      for (const block of msg.content as AnthropicContentBlock[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          out.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: block.text, annotations: [] }],
            status: 'completed',
          })
        } else if (block.type === 'tool_use') {
          out.push({
            type: 'function_call',
            call_id: block.id ?? `call_${counter++}`,
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          })
        }
      }
    }
  }

  return out
}
