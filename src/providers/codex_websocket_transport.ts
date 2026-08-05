import WebSocket, { type RawData } from 'ws'

export interface CodexWebSocketFrame {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly payload: string
}

function isTerminalResponseFrame(text: string): boolean {
  try {
    const value = JSON.parse(text) as { type?: unknown }
    return value.type === 'response.completed'
      || value.type === 'response.failed'
      || value.type === 'response.incomplete'
      || value.type === 'error'
  } catch {
    return false
  }
}

function websocketFrameText(data: RawData): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8')
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
  return data.toString('utf-8')
}

function nonJsonFrameDescriptor(text: string): string {
  const codePoints = Array.from(text.slice(0, 64), character => character.codePointAt(0)?.toString(16)).join(',')
  return `bytes=${Buffer.byteLength(text, 'utf-8')}; codePoints=${codePoints}`
}

/**
 * 只建立认证后的 WebSocket 并产出完整 JSON 帧。协议读取、流守卫和 Inbox 编码均由 agent-ir 持有。
 */
export async function* readCodexWebSocketFrames(frame: CodexWebSocketFrame): AsyncGenerator<string> {
  const socket = new WebSocket(frame.url, { headers: frame.headers })
  const queued: string[] = []
  let terminal = false
  let failure: Error | undefined
  let wake: (() => void) | undefined

  const notify = (): void => {
    const next = wake
    wake = undefined
    next?.()
  }
  const opened = new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      socket.send(frame.payload)
      resolve()
    })
    socket.once('error', error => reject(error))
  })
  socket.on('message', (data, isBinary) => {
    const text = websocketFrameText(data)
    try {
      const value = JSON.parse(text) as { type?: unknown }
      if (typeof value.type !== 'string') throw new Error('missing type')
    } catch {
      failure = new Error(`Codex WebSocket sent an invalid JSON frame (binary=${isBinary}; ${nonJsonFrameDescriptor(text)})`)
      socket.close()
      notify()
      return
    }
    queued.push(text)
    terminal ||= isTerminalResponseFrame(text)
    notify()
    if (terminal) socket.close()
  })
  socket.on('error', error => {
    failure = error
    notify()
  })
  socket.on('close', () => {
    if (!terminal && !failure) failure = new Error('Codex WebSocket closed before a terminal response frame')
    notify()
  })

  try {
    await opened
    while (true) {
      const next = queued.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (failure) throw failure
      if (terminal) return
      await new Promise<void>(resolve => { wake = resolve })
    }
  } finally {
    socket.close()
  }
}
