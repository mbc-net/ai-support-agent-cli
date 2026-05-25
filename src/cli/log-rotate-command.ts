import type { Command } from 'commander'

import { t } from '../i18n'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, RotatingFileWriter } from '../log-rotator'
import { logger } from '../logger'

/**
 * Parse a human-readable size literal (`5MB`, `1024`, `5KB`) into bytes.
 * Accepts the suffix-less form too (interpreted as bytes). Returns null
 * when the input cannot be parsed so the caller can issue a clear error.
 */
export function parseSize(value: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?\s*$/i.exec(value)
  if (!match) return null
  const num = parseFloat(match[1])
  if (!Number.isFinite(num) || num < 0) return null
  const unit = (match[2] ?? 'B').toUpperCase()
  const multiplier =
    unit === 'GB' ? 1024 * 1024 * 1024
    : unit === 'MB' ? 1024 * 1024
    : unit === 'KB' ? 1024
    : 1
  return Math.floor(num * multiplier)
}

interface RotateOptions {
  maxSize?: string
  maxFiles?: string
  tee?: boolean
}

export interface ResolvedRotateOptions {
  maxBytes: number
  maxFiles: number
  teeEnabled: boolean
}

/**
 * Pure-function validator extracted so unit tests can exercise the
 * --max-size / --max-files / --no-tee parsing without spawning a real
 * stdin pipe. Returns either the resolved numeric options or an
 * already-localized error message the caller can `logger.error` on.
 */
export function resolveRotateOptions(opts: RotateOptions):
  | { ok: true; value: ResolvedRotateOptions }
  | { ok: false; error: string } {
  const maxBytes = opts.maxSize !== undefined ? parseSize(opts.maxSize) : DEFAULT_MAX_BYTES
  if (maxBytes === null || maxBytes <= 0) {
    return { ok: false, error: t('logRotate.invalidMaxSize', { value: opts.maxSize ?? '' }) }
  }
  // Reject any non-integer input outright (e.g. `5.9`, `3abc`, `7 `). parseInt
  // would silently truncate / accept these, which contradicts the strict
  // parseSize() above and surprises operators.
  let maxFiles: number
  if (opts.maxFiles === undefined) {
    maxFiles = DEFAULT_MAX_FILES
  } else if (/^\d+$/.test(opts.maxFiles)) {
    maxFiles = Number(opts.maxFiles)
  } else {
    return { ok: false, error: t('logRotate.invalidMaxFiles', { value: opts.maxFiles }) }
  }
  if (!Number.isFinite(maxFiles) || maxFiles < 0) {
    return { ok: false, error: t('logRotate.invalidMaxFiles', { value: opts.maxFiles ?? '' }) }
  }
  // tee defaults to TRUE so the existing OS-level redirection (systemd
  // StandardOutput=append:..., launchd StandardOutPath=...) still receives
  // the agent's output during a transition / as belt-and-braces backup.
  // `--no-tee` is available for callers that want the rotated file to be
  // the sole sink (e.g. tests, or operators who want to avoid double-write).
  const teeEnabled = opts.tee !== false
  return { ok: true, value: { maxBytes, maxFiles, teeEnabled } }
}

/**
 * Stream stdin → a `RotatingFileWriter`, optionally tee-ing each chunk
 * back to stdout so an outer pipeline (e.g. the wrapper script's docker
 * subprocess) can still observe the agent's output. Default: tee enabled
 * so the existing systemd / launchd `StandardOutput` redirection (the
 * fallback container of last resort) keeps receiving everything.
 *
 * Designed for the per-project wrapper script:
 *
 *     docker run ... 2>&1 | ai-support-agent log-rotate <path>
 *
 * Lives outside the normal agent process tree so a crash in the agent
 * never strands the writer (it just sees EOF on stdin and exits).
 */
function runLogRotate(filePath: string, opts: RotateOptions): void {
  const resolved = resolveRotateOptions(opts)
  if (!resolved.ok) {
    logger.error(resolved.error)
    process.exit(2)
  }
  const { maxBytes, maxFiles, teeEnabled } = resolved.value

  const writer = new RotatingFileWriter({ filePath, maxBytes, maxFiles })

  let exitCode = 0
  const stop = (): void => {
    writer.close()
    // Node will exit naturally once stdin EOF + writer closed; force exit
    // only after signal so we don't hang on a slow pipe.
    process.exit(exitCode)
  }

  process.stdin.on('data', (chunk: Buffer) => {
    try {
      writer.write(chunk)
      if (teeEnabled) process.stdout.write(chunk)
    } catch (error) {
      // A write error means the disk filled, perms changed, etc. Don't
      // crash the wrapper — fall back to passthrough so the agent's output
      // still reaches systemd/launchd's StandardOutput. Log once.
      const message = error instanceof Error ? error.message : String(error)
      logger.error(t('logRotate.writeFailed', { path: filePath, message }))
      exitCode = 1
      if (teeEnabled) process.stdout.write(chunk)
    }
  })
  process.stdin.on('end', stop)
  process.stdin.on('error', () => stop())
  // Forward common termination signals so launchd / systemd can stop the
  // wrapper cleanly. The writer flushes via `close()` (sync fs.closeSync),
  // so no buffered data is lost.
  process.on('SIGTERM', () => stop())
  process.on('SIGINT', () => stop())
  process.on('SIGHUP', () => stop())
}

export function registerLogRotateCommand(program: Command): void {
  program
    .command('log-rotate')
    .description(t('cmd.logRotate'))
    .argument('<path>', t('cmd.logRotate.path'))
    .option('--max-size <size>', t('cmd.logRotate.maxSize'), `${DEFAULT_MAX_BYTES}`)
    .option('--max-files <n>', t('cmd.logRotate.maxFiles'), `${DEFAULT_MAX_FILES}`)
    .option('--no-tee', t('cmd.logRotate.noTee'))
    .action((filePath: string, opts: RotateOptions) => {
      runLogRotate(filePath, opts)
    })
}
