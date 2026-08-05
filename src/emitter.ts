/**
 * AnthropicEventEmitter — State machine to manage and yield unified Anthropic-style SSE event sequences
 */

import { formatSSE, tryParseJSON } from './sse.js'
import { pickAnthropicUsage } from './usage.js'
import type { GatewayLogger } from './logging.js'

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
  // 缓存命中/写入的 token。它们一样占上下文窗口，出口算 prompt_tokens 必须加回去，
  // 所以要跟着 IR 一路带到出站流里(见 usage.ts 的口径说明)。
  private cacheReadTokens = 0
  private cacheCreationTokens = 0
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
  // 未被任何 case 认领的上游事件计数，以及裸转发流里是否见过上游自己的终止帧。
  private unhandledCount = 0
  private upstreamTerminalSeen = false
  private readonly trace: string
  private readonly logger: GatewayLogger | undefined

  // trace 只用来把 unhandled 归到某一次请求上；provider 单测里不给也能跑，
  // 那时日志归到 'untraced'，计数照常。
  constructor(trace?: string, logger?: GatewayLogger) {
    this.trace = trace && trace.length > 0 ? trace : 'untraced'
    this.logger = logger
  }

  /**
   * 收到一个本 provider 不认识的上游事件。
   *
   * 只累计、只落盘，**绝不碰出站字节流** —— 出站形状必须与改造前逐字节一致。
   *
   * 之所以要有这个方法：parseStream 是纯命令式副作用契约，每个 provider 那个 switch
   * 的缺省分支就是黑洞 —— 没匹配上的事件被直接 continue 掉，循环照样走到 finish()，
   * 客户端拿到一个「200 但空」的假成功。实测一天 126 次 context_length_exceeded 全是
   * 这么消失的，调用方分不清"没话说"和"上游拒了"，只能盲重试到自己的 retry cap。
   * 上游哪天加个新事件类型，不该再靠故障反推才发现。
   */
  unhandled(rawType: string, raw: unknown): void {
    this.unhandledCount += 1
    this.logger?.warn(
      {
        event: 'outbox.unhandled_stream_event',
        rawType,
        rawKind: raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
        rawBytes: safeSerializedByteLength(raw),
        unhandledCount: this.unhandledCount,
      },
      'Outbox emitted an unhandled stream event',
    )
  }

  getUnhandledCount(): number {
    return this.unhandledCount
  }

  /** 裸转发(emitRawChunk)专用：上游是否发过自己的终止帧(message_stop / error)。 */
  hasUpstreamTerminal(): boolean {
    return this.upstreamTerminalSeen
  }

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

  setUsage(opts: {
    input?: number
    output?: number
    cacheRead?: number
    cacheCreation?: number
  }): void {
    if (typeof opts.input === 'number') this.inputTokens = opts.input
    if (typeof opts.output === 'number') this.outputTokens = opts.output
    if (typeof opts.cacheRead === 'number') this.cacheReadTokens = opts.cacheRead
    if (typeof opts.cacheCreation === 'number') this.cacheCreationTokens = opts.cacheCreation
  }

  getUsage(): {
    input: number
    output: number
    cacheRead: number
    cacheCreation: number
  } {
    return {
      input: this.inputTokens,
      output: this.outputTokens,
      cacheRead: this.cacheReadTokens,
      cacheCreation: this.cacheCreationTokens,
    }
  }

  // 出站 Anthropic SSE 的 usage 载荷。缓存字段只在真有值时出现 —— 恒定写 0 会让下游
  // 分不清「上游不支持缓存」和「这轮没命中」。
  private usagePayload(): Record<string, number> {
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      ...(this.cacheReadTokens > 0 ? { cache_read_input_tokens: this.cacheReadTokens } : {}),
      ...(this.cacheCreationTokens > 0
        ? { cache_creation_input_tokens: this.cacheCreationTokens }
        : {}),
    }
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
        usage: this.usagePayload(),
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
        const obj = JSON.parse(payload) as { type?: string }
        // 字段名只认一处(usage.pickAnthropicUsage)，别在这里再抄一遍。
        const picked = pickAnthropicUsage(obj)
        this.setUsage({
          input: picked.inputTokens,
          output: picked.outputTokens,
          cacheRead: picked.cacheReadTokens,
          cacheCreation: picked.cacheCreationTokens,
        })
        // 转发过来的原始流里已经有 message_stop 了，就不能再补一份自己的收尾。
        // 补了的话下游收到的是"一条 message 里两个 message_stop"，而且后补的那条
        // message_delta 用的是本 emitter 的默认 stop_reason=end_turn，会把上游真实的
        // stop_reason 覆盖掉 —— 实测 2026-08-02 的流量日志里，上游明明回
        // stop_reason:"max_tokens"，网关补的尾巴又改回 end_turn；tool_use 同理。
        // 经 /v1/chat/completions 出去时表现为两个 data:[DONE] 和一个多余的
        // finish_reason:"stop"。只有裸转发(emitRawChunk)的 provider 会走到这里。
        if (obj.type === 'message_stop') {
          this.finished = true
          this.upstreamTerminalSeen = true
        } else if (obj.type === 'error') {
          // 上游用 error 事件收尾同样是合法终止(PROTOCOL_REFERENCE §5.2)。它已经原样
          // 转发给客户端了，不能再被当成"流被掐断"二次报错。
          this.upstreamTerminalSeen = true
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

function safeSerializedByteLength(value: unknown): number | undefined {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return undefined
  }
}
