import * as fs from 'fs'
import * as path from 'path'

/**
 * Default rotation policy: rotate when the active file would exceed 5 MiB,
 * keep up to 5 rotated generations (`<path>.1` … `<path>.5`). Matches the
 * settings advertised by `service install` so operators don't need to
 * remember separate numbers for the two paths.
 */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_MAX_FILES = 5

export interface RotatingFileWriterOptions {
  /** Absolute path to the active log file. */
  filePath: string
  /**
   * Rotate AFTER a write would push the active file past this many bytes.
   * Writes are never split mid-buffer; a chunk that is itself larger than
   * `maxBytes` is allowed through (the next write will trigger rotation).
   * Must be > 0.
   */
  maxBytes?: number
  /**
   * Number of rotated generations to keep. `<filePath>.1` is the most
   * recently rotated; older generations age out toward `<filePath>.N` and
   * are removed when they would otherwise become `<filePath>.(N+1)`.
   * `maxFiles <= 0` keeps zero generations (rotated file is unlinked
   * immediately).
   */
  maxFiles?: number
}

/**
 * Append-mode writer that rotates by size.
 *
 * Designed for the `ai-support-agent log-rotate` CLI: a single long-lived
 * process consumes its parent's stdout/stderr stream and persists it to
 * a bounded set of files. The CLI is the only entrypoint that exists in
 * practice, but the writer is separated so unit tests can exercise the
 * rotation arithmetic without spawning a real subprocess.
 *
 * Synchronous I/O is intentional: this writer sits on the hot path of the
 * agent's stdout, and an async backlog during a write storm would cause
 * the parent's pipe buffer to fill and block (which then stalls the agent).
 * The volumes involved (tens of MiB per day per project, max) are small
 * enough that the sync penalty is negligible — far cheaper than the
 * coordination cost of an async queue.
 */
export class RotatingFileWriter {
  private readonly filePath: string
  private readonly maxBytes: number
  private readonly maxFiles: number
  private fd: number | null = null
  private currentSize = 0

  constructor(options: RotatingFileWriterOptions) {
    this.filePath = options.filePath
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    if (this.maxBytes <= 0) {
      throw new Error(`RotatingFileWriter: maxBytes must be > 0 (got ${this.maxBytes})`)
    }
  }

  /**
   * Write a chunk to the active log file. Rotates beforehand if appending
   * the chunk would push the file past `maxBytes`. Returns the number of
   * bytes written (always `chunk.length` on success).
   */
  write(chunk: Buffer | string): number {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk
    if (buffer.length === 0) return 0
    this.ensureOpen()
    // Rotate BEFORE this write if the file already holds content AND the
    // pending chunk would push it over the limit. A chunk that on its own
    // exceeds the limit is still written in full to the freshly-rotated
    // file — splitting would corrupt multi-byte characters / log lines.
    if (this.currentSize > 0 && this.currentSize + buffer.length > this.maxBytes) {
      this.rotate()
      this.ensureOpen()
    }
    fs.writeSync(this.fd!, buffer)
    this.currentSize += buffer.length
    return buffer.length
  }

  /** Flush + release the underlying file descriptor. Idempotent. */
  close(): void {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd) } catch { /* already closed */ }
      this.fd = null
    }
  }

  /**
   * Open the active file in append mode and record its current size. Called
   * lazily on first write so constructing a writer is side-effect-free
   * (helps tests). Ensures the parent directory exists.
   */
  private ensureOpen(): void {
    if (this.fd !== null) return
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    this.fd = fs.openSync(this.filePath, 'a')
    try {
      const stat = fs.fstatSync(this.fd)
      this.currentSize = stat.size
    } catch {
      // Brand-new file or stat failure — start from zero rather than fail.
      this.currentSize = 0
    }
  }

  /**
   * Rename the active file to `<path>.1`, shifting any pre-existing
   * generations down by one. The oldest generation that falls past
   * `maxFiles` is unlinked. After rotation the active path is empty.
   *
   * Rename order is high → low so we never overwrite a live generation
   * mid-rotation. All steps tolerate ENOENT (a generation may not exist
   * yet) so a fresh install does not crash on the first rotation.
   */
  private rotate(): void {
    this.close()
    // Drop the oldest generation that would otherwise outlive maxFiles.
    if (this.maxFiles <= 0) {
      // No history requested — just remove the active file.
      try { fs.unlinkSync(this.filePath) } catch { /* not present */ }
      this.currentSize = 0
      return
    }
    const oldest = `${this.filePath}.${this.maxFiles}`
    try { fs.unlinkSync(oldest) } catch { /* not present */ }
    // Shift `<path>.(i-1)` → `<path>.i` for i = maxFiles..2.
    for (let i = this.maxFiles; i >= 2; i--) {
      const src = `${this.filePath}.${i - 1}`
      const dst = `${this.filePath}.${i}`
      try { fs.renameSync(src, dst) } catch { /* src not present */ }
    }
    // Finally promote the active file to `.1`.
    try {
      fs.renameSync(this.filePath, `${this.filePath}.1`)
    } catch {
      // Active file may have been removed externally between the size
      // check and the rename — that's fine; ensureOpen() will recreate it.
    }
    this.currentSize = 0
  }
}
