/**
 * AnthropicEventEmitter — State machine to manage and yield unified Anthropic-style SSE event sequences
 */

import { formatSSE, tryParseJSON } from './sse.js'

type BlockType = 'text' | 'thinking' | 'tool_use'

export interface EmitterStartOpts {
  model: string
  inputTokens?: number
  messageId?: string
}

export class AnthropicEventEmitter {
  private messageId = ''
  private model = ''
  private inputTokens = 0
  private outputTokens = 0
  private currentBlockIndex = -1
  private currentBlockType: BlockType | null = null
  private currentToolCallId = ''
  private toolArgsBuffer = ''
  private stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' = 'end_turn'
  private previousText = ''
  private chunks: string[] = []
  private started = false
  private finished = false
  private toolUseCount = 0
  // Fault-tolerance bookkeeping: did this turn yield anything the harness can act on
  // (visible text or a tool call)? `unusable` is set when the upstream turn collapsed
  // (e.g. MALFORMED_FUNCTION_CALL with no content) so the adapter can retry.
  private producedContent = false
  private unusable = false

  hasProducedContent(): boolean {
    return this.producedContent
  }
  markUnusable(): void {
    this.unusable = true
  }
  isUnusable(): boolean {
    return this.unusable
  }

  start(opts: EmitterStartOpts): void {
    if (this.started) return
    this.started = true
    this.messageId = opts.messageId ?? `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    this.model = opts.model
    this.inputTokens = opts.inputTokens ?? 0
    this.chunks.push(
      formatSSE('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: this.inputTokens, output_tokens: 0 },
        },
      }),
    )
  }

  pushText(delta: string): void {
    if (!delta) return
    this.producedContent = true
    this.ensureStarted()
    this.switchBlock('text')
    this.chunks.push(
      formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: { type: 'text_delta', text: delta },
      }),
    )
  }

  pushTextAccumulated(full: string): void {
    if (!full) return
    if (full.startsWith(this.previousText)) {
      const delta = full.slice(this.previousText.length)
      this.previousText = full
      if (delta) this.pushText(delta)
      return
    }
    this.previousText = full
    this.pushText(full)
  }

  pushThinking(delta: string): void {
    if (!delta) return
    this.ensureStarted()
    this.switchBlock('thinking')
    this.chunks.push(
      formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: { type: 'thinking_delta', thinking: delta },
      }),
    )
  }

  openToolUse(id: string, name: string): void {
    this.producedContent = true
    this.ensureStarted()
    this.closeBlock()
    this.currentBlockIndex += 1
    this.currentBlockType = 'tool_use'
    this.currentToolCallId = id
    this.toolArgsBuffer = ''
    this.toolUseCount += 1
    this.chunks.push(
      formatSSE('content_block_start', {
        type: 'content_block_start',
        index: this.currentBlockIndex,
        content_block: { type: 'tool_use', id, name, input: {} },
      }),
    )
  }

  pushToolArgsDelta(chunk: string): void {
    if (!chunk || this.currentBlockType !== 'tool_use') return
    this.toolArgsBuffer += chunk
    this.chunks.push(
      formatSSE('content_block_delta', {
        type: 'content_block_delta',
        index: this.currentBlockIndex,
        delta: { type: 'input_json_delta', partial_json: chunk },
      }),
    )
  }

  closeBlock(): void {
    if (this.currentBlockType === null) return
    if (this.currentBlockType === 'tool_use') {
      const parsed = tryParseJSON(this.toolArgsBuffer || '{}')
      if (parsed === null && this.toolArgsBuffer) {
        this.chunks.push(
          formatSSE('content_block_delta', {
            type: 'content_block_delta',
            index: this.currentBlockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: JSON.stringify({ raw_arguments: this.toolArgsBuffer }),
            },
          }),
        )
      }
    }
    this.chunks.push(
      formatSSE('content_block_stop', {
        type: 'content_block_stop',
        index: this.currentBlockIndex,
      }),
    )
    this.currentBlockType = null
    this.previousText = ''
  }

  setStopReason(r: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence'): void {
    this.stopReason = r
  }

  setUsage(opts: { input?: number; output?: number }): void {
    if (typeof opts.input === 'number') this.inputTokens = opts.input
    if (typeof opts.output === 'number') this.outputTokens = opts.output
  }

  getUsage(): { input: number; output: number } {
    return { input: this.inputTokens, output: this.outputTokens }
  }

  getToolUseCount(): number {
    return this.toolUseCount
  }

  addOutputTokens(n: number): void {
    if (n > 0) this.outputTokens += n
  }

  finish(): void {
    if (this.finished) return
    this.finished = true
    this.closeBlock()
    this.chunks.push(
      formatSSE('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: this.stopReason, stop_sequence: null },
        usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
      }),
    )
    this.chunks.push(formatSSE('message_stop', { type: 'message_stop' }))
  }

  error(err: { type?: string; message?: string } | Error): void {
    const errMsg = err instanceof Error ? err.message : err.message ?? 'unknown error'
    const errType = err instanceof Error ? 'api_error' : err.type ?? 'api_error'
    this.chunks.push(
      formatSSE('error', {
        type: 'error',
        error: { type: errType, message: errMsg },
      }),
    )
  }

  drain(): string[] {
    if (this.chunks.length === 0) return []
    const out = this.chunks
    this.chunks = []
    return out
  }

  emitRawChunk(chunk: string): void {
    this.chunks.push(chunk)
    if (chunk.length === 0) return
    try {
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload.length === 0 || payload === '[DONE]') continue
        const obj = JSON.parse(payload) as {
          type?: string
          message?: { usage?: { input_tokens?: number; output_tokens?: number } }
          usage?: { input_tokens?: number; output_tokens?: number }
        }
        const usage = obj.message?.usage ?? obj.usage
        if (usage) {
          if (typeof usage.input_tokens === 'number') {
            this.setUsage({ input: usage.input_tokens })
          }
          if (typeof usage.output_tokens === 'number') {
            this.setUsage({ output: usage.output_tokens })
          }
        }
      }
    } catch {}
  }

  get currentToolId(): string {
    return this.currentToolCallId
  }

  private ensureStarted(): void {
    if (!this.started) {
      this.start({ model: this.model || 'unknown' })
    }
  }

  private switchBlock(target: BlockType): void {
    if (this.currentBlockType === target) return
    if (this.currentBlockType !== null) this.closeBlock()
    this.currentBlockIndex += 1
    this.currentBlockType = target
    if (target === 'text') {
      this.chunks.push(
        formatSSE('content_block_start', {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: { type: 'text', text: '' },
        }),
      )
    } else if (target === 'thinking') {
      this.chunks.push(
        formatSSE('content_block_start', {
          type: 'content_block_start',
          index: this.currentBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }),
      )
    }
  }
}
