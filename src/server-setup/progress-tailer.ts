/**
 * Incremental reader for the Ansible progress side-channel.
 *
 * WHY THIS EXISTS: `runAnsiblePlaybook()` uses `execFile`, which only hands
 * over stdout once the process has exited, and the bundled `json` stdout
 * callback only emits its document at `v2_playbook_on_stats` anyway. Together
 * that meant a server-setup run reported nothing at all until it finished, so
 * the UI sat on "実行中" with an empty log for the whole run.
 *
 * Rather than restructure the authoritative result path (and risk regressing
 * `maxBuffer`/`timeout`/spawn-failure handling), the callback additionally
 * appends NDJSON events to a side file — see the PROGRESS CONTRACT in
 * `ansible/callback_plugins/json.py` — and this module tails that file while
 * the playbook is still running.
 */

import { closeSync, openSync, readSync, statSync } from 'fs'

import { logger } from '../logger'

/** How often the tailer looks for newly appended events. */
export const PROGRESS_POLL_INTERVAL_MS = 1_000

/** Upper bound on bytes read in a single poll, mirroring the stdout cap. */
const MAX_READ_CHUNK_BYTES = 1024 * 1024

/**
 * The per-host outcome fields the callback forwards on an `end` event.
 *
 * Structurally identical to `AnsibleJsonHostResult` in server-setup-runner.ts
 * (which consumes these via `taskResultFrom()`); declared here rather than
 * imported so the runner can depend on this module without a cycle.
 */
export interface AnsibleProgressResult {
  failed?: boolean
  changed?: boolean
  skipped?: boolean
  unreachable?: boolean
  msg?: string
}

export interface AnsibleProgressEvent {
  /** 1-based, monotonic within a run; assigned by the callback plugin. */
  seq: number
  phase: 'start' | 'end'
  name: string
  /** Present on `end` events only. */
  host?: string
  /**
   * Present on `end` events only. Trimmed by the callback to just the fields
   * `taskResultFrom()` consumes, so the mapping to a `ServerSetupTaskResult`
   * stays in one place instead of being duplicated in Python.
   */
  result?: AnsibleProgressResult
}

function isProgressEvent(value: unknown): value is AnsibleProgressEvent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.seq === 'number' &&
    (candidate.phase === 'start' || candidate.phase === 'end') &&
    typeof candidate.name === 'string'
  )
}

/**
 * Reads whole NDJSON lines appended to a file since the previous call.
 *
 * Leftover bytes are kept as a `Buffer`, not a string: task names are
 * operator-authored and routinely non-ASCII, and decoding a half-read UTF-8
 * sequence would replace it with U+FFFD before the rest of it ever arrives.
 */
export class ProgressFileReader {
  private offset = 0
  private leftover: Buffer = Buffer.alloc(0)

  constructor(private readonly filePath: string) {}

  /**
   * Returns every complete event appended since the last call.
   *
   * Best-effort by design: the file living in the run's temp dir may not exist
   * yet (nothing has run), or may already be gone (cleanup raced us). Neither
   * is worth failing a playbook over, so both yield an empty batch.
   */
  read(): AnsibleProgressEvent[] {
    let size: number
    try {
      size = statSync(this.filePath).size
    } catch {
      return []
    }
    if (size <= this.offset) return []

    const length = Math.min(size - this.offset, MAX_READ_CHUNK_BYTES)
    const buffer = Buffer.alloc(length)
    let bytesRead = 0
    let handle: number | undefined
    try {
      handle = openSync(this.filePath, 'r')
      bytesRead = readSync(handle, buffer, 0, length, this.offset)
    } catch {
      return []
    } finally {
      if (handle !== undefined) {
        try {
          closeSync(handle)
        } catch {
          // The descriptor is being discarded either way.
        }
      }
    }
    if (bytesRead <= 0) return []
    this.offset += bytesRead

    const chunk = Buffer.concat([this.leftover, buffer.subarray(0, bytesRead)])
    const lastNewline = chunk.lastIndexOf(0x0a)
    if (lastNewline === -1) {
      this.leftover = chunk
      return []
    }
    this.leftover = chunk.subarray(lastNewline + 1)

    const events: AnsibleProgressEvent[] = []
    for (const line of chunk.subarray(0, lastNewline).toString('utf-8').split('\n')) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // A single corrupt line must not discard the rest of the batch.
        continue
      }
      if (isProgressEvent(parsed)) events.push(parsed)
    }
    return events
  }
}

export interface ProgressTailer {
  /** Stops polling and delivers anything written since the last tick. */
  stop(): Promise<void>
}

export interface StartProgressTailerOptions {
  filePath: string
  onEvents: (events: AnsibleProgressEvent[]) => Promise<void>
  intervalMs?: number
}

/**
 * Polls `filePath` and hands each new batch of events to `onEvents`.
 *
 * Batching is deliberate: one delivery per tick rather than per event keeps a
 * long playbook from producing one API request (and one AppSync notification)
 * per task.
 *
 * Delivery is single-flight — a slow `onEvents` delays the next batch instead
 * of running alongside it, so events cannot be reordered in transit.
 */
export function startProgressTailer(
  options: StartProgressTailerOptions,
): ProgressTailer {
  const { filePath, onEvents, intervalMs = PROGRESS_POLL_INTERVAL_MS } = options
  const reader = new ProgressFileReader(filePath)
  let inFlight = false
  let stopped = false

  const deliver = async (): Promise<void> => {
    const events = reader.read()
    if (events.length === 0) return
    try {
      await onEvents(events)
    } catch (error) {
      // Progress is a convenience channel; the authoritative result still
      // arrives via submitResult. Losing a batch must not stop later ones.
      logger.debug(
        `[server-setup] failed to deliver ${events.length} progress event(s): ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  // Tracks the delivery currently in flight so `stop()` can wait for it. A bare
  // boolean is not enough: the final drain must *join* the outstanding
  // delivery, not merely observe that one exists.
  let pending: Promise<void> = Promise.resolve()

  const timer = setInterval(() => {
    if (inFlight || stopped) return
    inFlight = true
    pending = deliver().finally(() => {
      inFlight = false
    })
  }, intervalMs)
  // Never hold the process open for the sake of progress reporting.
  timer.unref?.()

  return {
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      // Join any delivery already in flight before draining. Ansible finishing
      // while a batch is still being POSTed is the common case, not a corner
      // case, and starting the drain alongside it would put two `onEvents`
      // calls in flight at once — breaking the single-flight ordering
      // guarantee exactly when the last (often most interesting) events are
      // being reported. `deliver()` already absorbs its own rejections, but
      // guard anyway so a rejected in-flight promise cannot skip the drain.
      await pending.catch(() => undefined)
      // Ansible commonly finishes between two ticks; without this final read
      // the last tasks of a run would never be reported.
      await deliver()
    },
  }
}
