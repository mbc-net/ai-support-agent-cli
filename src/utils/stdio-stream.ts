import type { ChildProcess } from 'child_process'
import { Duplex, type Readable, type Transform } from 'stream'

import { logger } from '../logger'
import { killSubprocess } from '../mcp/tools/db-ssm-tunnel'
import { captureStderrTail } from './stderr-tail'

/**
 * Turn a subprocess's stdin/stdout into one stream — the carrier for
 * `tailscale nc` and for SSM's `AWS-StartSSHSession` in stdio mode. Neither
 * opens a listening socket, so nothing but the agent can use the tunnel.
 *
 * **When is it "open"?** A successful spawn only means the binary started —
 * `tailscale nc` and the SSM plugin fail *after* that (unknown host, target
 * not connected, access denied) and exit. The stream is handed out once the
 * process either produced its first output, or stayed alive for `settleMs`.
 * An exit before that is a failure, reported with the tail of stderr.
 *
 * Every exit path ends the process: the stream closing kills it, a start that
 * fails or takes too long kills it. When the process ends by itself the stream
 * ends **after stdout has been read to the end**, so the last bytes it wrote
 * are not dropped.
 *
 * @param child spawned with `stdio: ['pipe', 'pipe', 'pipe']`
 */
export interface StdioStreamOptions {
  /** Names the process in messages (no secrets). */
  label: string
  /** Deadline for the process to start at all. */
  timeoutMs: number
  /** How long the process must stay alive to count as open. Default 2 s. */
  settleMs?: number
  /** Filter for stdout before it reaches the caller (e.g. drop a banner). */
  transformStdout?: () => Transform
}

/** Default for {@link StdioStreamOptions.settleMs}. */
export const STDIO_STREAM_SETTLE_MS = 2_000
/** Upper bound on waiting for stdout to drain after the process exited. */
const DRAIN_AFTER_EXIT_MS = 5_000

export function openStdioStream(child: ChildProcess, options: StdioStreamOptions): Promise<Duplex> {
  const { label, timeoutMs } = options
  const settleMs = options.settleMs ?? STDIO_STREAM_SETTLE_MS
  const stderrTail = captureStderrTail(child.stderr)

  return new Promise<Duplex>((resolve, reject) => {
    let settled = false
    let exited: { code: number | null } | null = null
    let settleTimer: NodeJS.Timeout | undefined

    const fail = (message: string, kill: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(startTimer)
      clearTimeout(settleTimer)
      if (kill) void killSubprocess(child)
      reject(new Error(message))
    }

    const startTimer = setTimeout(
      () => fail(`${label} did not start within ${timeoutMs}ms`, true),
      timeoutMs,
    )
    startTimer.unref?.()

    child.on('error', (err: Error) => {
      if (!settled) {
        fail(`${label} could not be started: ${err.message}`, true)
        return
      }
      logger.warn(`[stdio-stream] ${label} error: ${err.message}`)
    })

    child.once('exit', (code: number | null) => {
      exited = { code }
      // stderr may still be flushing; give it a turn before quoting it.
      setImmediate(() =>
        fail(`${label} exited before it was ready (code=${code})${stderrTail()}`, false),
      )
    })

    const open = (): void => {
      if (settled || exited) return
      settled = true
      clearTimeout(startTimer)
      clearTimeout(settleTimer)
      resolve(wrap())
    }

    child.once('spawn', () => {
      settleTimer = setTimeout(open, settleMs)
      settleTimer.unref?.()
      // 'readable' does not consume: the first bytes stay for the caller.
      child.stdout?.once('readable', open)
    })

    const wrap = (): Duplex => {
      // EPIPE on a closing process must not surface as an unhandled 'error'.
      child.stdin?.on('error', () => undefined)
      const stdout = child.stdout as Readable
      const readable: Readable = options.transformStdout
        ? stdout.pipe(options.transformStdout())
        : stdout
      const duplex = Duplex.from({ readable, writable: child.stdin })
      let ended = false
      const end = (): void => {
        if (ended) return
        ended = true
        duplex.destroy()
        void killSubprocess(child)
      }
      duplex.on('error', end)
      duplex.once('close', end)
      // stdout finished (after the caller read it all): the process is done
      // talking, so finish the stream even though stdin is still open.
      duplex.once('end', end)
      if (readable !== stdout) readable.once('error', end)

      const afterExit = (code: number | null): void => {
        if (code) logger.warn(`[stdio-stream] ${label} exited with code ${code}${stderrTail()}`)
        // Let the stream deliver what stdout still holds; it closes itself
        // once stdout ends. The timer only bounds a stdout that never ends.
        const timer = setTimeout(end, DRAIN_AFTER_EXIT_MS)
        timer.unref?.()
        duplex.once('close', () => clearTimeout(timer))
      }
      child.once('exit', afterExit)
      return duplex
    }
  })
}
