/**
 * Passthrough Utilities: Filtering non-messages endpoints and body extractor
 */

import type { AnthropicMessagesRequest } from './types.js'

export function shouldPassthrough(input: RequestInfo | URL): boolean {
  const url = input instanceof Request ? input.url : String(input)
  return !url.includes('/v1/messages')
}

export async function extractRequestBody(
  init?: RequestInit,
): Promise<AnthropicMessagesRequest> {
  if (!init?.body) return { messages: [] }
  let text: string
  if (init.body instanceof ReadableStream) {
    text = await new Response(init.body).text()
  } else if (typeof init.body === 'string') {
    text = init.body
  } else if (init.body instanceof Uint8Array) {
    text = new TextDecoder('utf-8').decode(init.body)
  } else if (init.body instanceof ArrayBuffer) {
    text = new TextDecoder('utf-8').decode(new Uint8Array(init.body))
  } else {
    text = String(init.body)
  }
  try {
    return JSON.parse(text) as AnthropicMessagesRequest
  } catch {
    return { messages: [] }
  }
}

export function debugLog(label: string, payload: unknown): void {
  if (process.env.DEBUG_WIRE) {
    console.error(`[wire:${label}]`, typeof payload === 'string' ? payload : JSON.stringify(payload))
  }
}
