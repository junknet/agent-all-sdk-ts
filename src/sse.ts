/**
 * SSE Utilities: Input stream parser (iterSSE) and output event formatter (formatSSE)
 */

export interface SSEEvent {
  event?: string
  data: string
}

export async function* iterSSE(response: Response): AsyncIterable<SSEEvent> {
  if (!response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let pendingEvent: string | undefined
  let pendingData: string[] = []

  const flush = function* (): Iterable<SSEEvent> {
    if (pendingData.length === 0 && pendingEvent === undefined) return
    const data = pendingData.join('\n')
    if (data === '[DONE]') {
      pendingData = []
      pendingEvent = undefined
      return
    }
    yield { event: pendingEvent, data }
    pendingData = []
    pendingEvent = undefined
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.length > 0) {
          for (const line of buffer.split('\n')) {
            handleLine(line.trim(), { setEvent: e => (pendingEvent = e), pushData: d => pendingData.push(d) })
          }
          buffer = ''
        }
        yield* flush()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line === '') {
          yield* flush()
        } else {
          handleLine(line, { setEvent: e => (pendingEvent = e), pushData: d => pendingData.push(d) })
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

function handleLine(
  line: string,
  ctx: { setEvent: (e: string) => void; pushData: (d: string) => void },
): void {
  if (line.startsWith(':')) return
  if (line.startsWith('event:')) {
    ctx.setEvent(line.slice(6).trim())
    return
  }
  if (line.startsWith('data:')) {
    let payload = line.slice(5)
    if (payload.startsWith(' ')) payload = payload.slice(1)
    ctx.pushData(payload)
    return
  }
}

export function formatSSE(eventType: string, data: unknown): string {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}

export function tryParseJSON<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
