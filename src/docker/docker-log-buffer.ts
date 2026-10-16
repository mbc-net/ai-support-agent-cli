import { DOCKER_MAX_SESSION_LOG_BYTES, DOCKER_MAX_LOG_CHUNK_BYTES } from '../constants'
import { appendWithLimit } from '../utils'

/** Buffers Docker output for chunk delivery and a size-limited session log. */
export class DockerLogBuffer {
  private seq = 0
  private fullLog = ''
  private logTruncated = false
  private buffer = ''

  constructor(
    private readonly onTruncated: () => void,
    private readonly sendChunk?: (seq: number, text: string) => Promise<unknown>,
  ) {}

  get bufferedLength(): number { return this.buffer.length }
  get content(): string { return this.fullLog }

  append(text: string): void { this.buffer += text }

  async flush(): Promise<void> {
    if (!this.buffer) return
    const text = this.buffer
    // Clear before awaiting delivery so overlapping flushes keep their existing behavior.
    this.buffer = ''
    if (!this.logTruncated) {
      const appended = appendWithLimit(this.fullLog, text, DOCKER_MAX_SESSION_LOG_BYTES)
      this.fullLog = appended.result
      if (appended.truncated) {
        this.logTruncated = true
        this.onTruncated()
      }
    }
    if (this.sendChunk) {
      for (let offset = 0; offset < text.length; offset += DOCKER_MAX_LOG_CHUNK_BYTES) {
        const slice = text.slice(offset, offset + DOCKER_MAX_LOG_CHUNK_BYTES)
        await this.sendChunk(++this.seq, slice)
      }
    }
  }
}
