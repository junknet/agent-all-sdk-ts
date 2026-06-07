/**
 * Inbound image auto-compression — keeps request payloads small before they hit any
 * provider (Antigravity/Gemini especially is size-sensitive). Mirrors the old Go
 * gateway/image/processor.go (max 2048px, JPEG q80) but smarter: it only KEEPS the
 * re-encoded image if it is actually smaller. Terminal screenshots / line-art are
 * flat-color and compress better as PNG — blindly forcing JPEG (the Go behaviour)
 * would BLOAT them, so we compare and keep the winner per image.
 *
 * Uses ImageMagick (`magick`) via stdin→stdout pipe: no node-native addon, no temp
 * files, no PATH-fragile assumptions beyond /usr/bin (present in the supervisor PATH).
 * Any failure (missing binary, decode error) falls back to the original image —
 * compression never breaks a request.
 */

import type { AnthropicContentBlock, AnthropicMessagesRequest } from './types.js'
import { devlog } from './devlog.js'

const MAX_DIM = 2048
const JPEG_QUALITY = 80
// Skip tiny images: re-encoding icons/avatars wastes a subprocess for no gain.
const MIN_RAW_BYTES = 64 * 1024

// Re-encode one base64 image; returns the smaller-or-null. null = keep original.
async function recompress(b64: string): Promise<{ data: string; media_type: string } | null> {
  let input: Buffer
  try {
    input = Buffer.from(b64, 'base64')
  } catch {
    return null
  }
  if (input.length < MIN_RAW_BYTES) return null
  try {
    // `2048x2048>` only downsizes when larger (never upscales); q80 JPEG to stdout.
    const proc = Bun.spawn(['magick', '-', '-resize', `${MAX_DIM}x${MAX_DIM}>`, '-quality', String(JPEG_QUALITY), 'jpeg:-'], {
      stdin: input,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = Buffer.from(await new Response(proc.stdout).arrayBuffer())
    await proc.exited
    if (proc.exitCode !== 0 || out.length === 0) return null
    const outB64 = out.toString('base64')
    // Only adopt the JPEG if it actually shrank the base64 payload.
    if (outB64.length >= b64.length) return null
    return { data: outB64, media_type: 'image/jpeg' }
  } catch {
    return null
  }
}

// Collect every base64 image block, including those nested inside tool_result content
// (agents read screenshots via tools — those land here and are usually the big ones).
function collectImageBlocks(content: unknown, acc: AnthropicContentBlock[]): void {
  if (!Array.isArray(content)) return
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const blk = raw as AnthropicContentBlock
    if (blk.type === 'image' && blk.source && (blk.source as { type?: string }).type === 'base64') {
      acc.push(blk)
    } else if (blk.type === 'tool_result' && Array.isArray(blk.content)) {
      collectImageBlocks(blk.content, acc)
    }
  }
}

/**
 * Compress all base64 images in the request in place. No-op when there are none.
 * Concurrent across images; per-image failures leave that image untouched.
 */
export async function compressImages(req: AnthropicMessagesRequest, trace?: string): Promise<void> {
  const blocks: AnthropicContentBlock[] = []
  for (const m of req.messages ?? []) collectImageBlocks(m.content, blocks)
  if (blocks.length === 0) return

  let recompressed = 0
  let savedChars = 0
  await Promise.all(
    blocks.map(async blk => {
      const src = blk.source as { type: string; media_type: string; data: string }
      const before = src.data.length
      const result = await recompress(src.data)
      if (result) {
        src.data = result.data
        src.media_type = result.media_type
        recompressed += 1
        savedChars += before - result.data.length
      }
    }),
  )

  if (trace) {
    devlog(trace, 'image_compress', { images: blocks.length, recompressed, savedBase64Chars: savedChars })
  }
}
