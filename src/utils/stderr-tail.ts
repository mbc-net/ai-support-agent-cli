import type { Readable } from 'stream'

import { SSM_STDERR_MAX_BYTES } from '../constants'

/**
 * Keep the last `maxBytes` of a subprocess's stderr — the tail, where the
 * failure reason is — without letting a chatty process grow it unbounded.
 *
 * @returns a function giving `": <tail>"`, or `""` when nothing was written,
 *   ready to append to an error message
 */
export function captureStderrTail(
  stream: Pick<Readable, 'on'> | null | undefined,
  maxBytes: number = SSM_STDERR_MAX_BYTES,
): () => string {
  let buffer = ''
  stream?.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString()
    if (buffer.length > maxBytes) buffer = buffer.slice(buffer.length - maxBytes)
  })
  return () => {
    const trimmed = buffer.trim()
    return trimmed ? `: ${trimmed}` : ''
  }
}
