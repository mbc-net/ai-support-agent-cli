/** Ansible task result parsing and redacted progress serialization. */
import {
  SERVER_SETUP_MAX_PROGRESS_MESSAGE_LENGTH,
  SERVER_SETUP_MAX_PROGRESS_TASK_NAME_LENGTH,
} from '../constants'
import type { ServerSetupProgressEvent, ServerSetupTaskResult } from '../types'
import { redactSecretValues } from '../utils/secret-redaction'
import type { AnsibleProgressEvent } from './progress-tailer'

interface AnsibleJsonHostResult {
  failed?: boolean
  changed?: boolean
  skipped?: boolean
  unreachable?: boolean
  msg?: string
}

/**
 * Turn raw callback events into the wire form the API stores, redacting on the
 * way.
 *
 * The `end` mapping goes through the same `taskResultFrom` the authoritative
 * results use, so a task cannot be summarised one way mid-run and another way
 * once the run finishes — Ansible's result semantics stay in one place instead
 * of being reimplemented in the API.
 *
 * Redaction is applied here because progress leaves the agent *before* the
 * run's stdout is redacted. The callback already withholds `msg` for `no_log`
 * tasks and for anything that did not fail, but that only guards the task's own
 * parameters: a secret can still surface in an unrelated task's failure message
 * or be embedded in an operator-authored task name.
 */
/**
 * Cut `text` down to `limit` characters, marking that it was cut.
 *
 * The API rejects an over-long field by failing validation for the *whole*
 * request, and the tailer has already advanced past those events by then — so
 * an un-truncated field does not just lose itself, it loses its entire batch
 * silently. Truncating here keeps the batch deliverable, and the marker keeps
 * the loss visible (the untruncated text still reaches `executionLogs` through
 * the authoritative result).
 */
function truncateForApi(text: string, limit: number): string {
  if (text.length <= limit) return text
  const marker = '… (truncated)'
  return text.slice(0, Math.max(0, limit - marker.length)) + marker
}

export function toProgressPayload(
  events: AnsibleProgressEvent[],
  secretValues: string[],
): ServerSetupProgressEvent[] {
  const redact = (text: string): string =>
    secretValues.length === 0 ? text : redactSecretValues(text, secretValues)
  return events.map((event) => {
    // Redact *before* truncating: cutting first could split a secret so that
    // neither half matches the redaction needle, leaking the remaining part.
    const name = truncateForApi(
      redact(event.name),
      SERVER_SETUP_MAX_PROGRESS_TASK_NAME_LENGTH,
    )
    if (event.phase === 'start') return { seq: event.seq, phase: 'start', name }
    const result = taskResultFrom(event.name, [event.result ?? {}])
    return {
      seq: event.seq,
      phase: 'end',
      name,
      status: result.status,
      changed: result.changed,
      message: truncateForApi(
        redact(result.message),
        SERVER_SETUP_MAX_PROGRESS_MESSAGE_LENGTH,
      ),
    }
  })
}

interface AnsibleJsonTask {
  task?: { name?: string }
  hosts?: Record<string, AnsibleJsonHostResult>
}

interface AnsibleJsonPlay {
  tasks?: AnsibleJsonTask[]
}

interface AnsibleJsonOutput {
  plays?: AnsibleJsonPlay[]
}

interface ParsedAnsibleOutput {
  taskResults: ServerSetupTaskResult[]
  /**
   * True when `rawOutput` was empty or not valid JSON at all — as opposed to
   * parsing successfully into an object that merely lacks tasks.
   * `runServerSetup` must never report `successResult` on top of this: an
   * empty/unparseable stdout despite a `0` exit code means the `json` callback
   * plugin never ran, so there is no reliable signal that anything actually
   * happened.
   */
  outputUnparseable: boolean
}

/**
 * Derive one `ServerSetupTaskResult` from a task's per-host results.
 * `unreachable` is folded into `failed` (with a sensible default message), so
 * the reported status set stays `ok`/`failed`/`skipped`.
 */
function taskResultFrom(name: string, results: AnsibleJsonHostResult[]): ServerSetupTaskResult {
  const changed = results.some((r) => r.changed === true)
  const failedResult = results.find((r) => r.failed === true || r.unreachable === true)
  if (failedResult) {
    const message =
      failedResult.msg ?? (failedResult.unreachable === true ? 'host unreachable' : `${name} failed`)
    return { name, status: 'failed', changed, message }
  }
  if (results.length > 0 && results.every((r) => r.skipped === true)) {
    return { name, status: 'skipped', changed: false, message: `${name} skipped` }
  }
  return { name, status: 'ok', changed, message: `${name} completed` }
}

/**
 * Parse the `ansible-playbook --stdout-callback=json`-style output into one
 * result **per task** (the previous per-stepType grouping is gone). Tasks with
 * no name and no host results are skipped entirely.
 */
export function parseAnsibleOutput(rawOutput: string): ParsedAnsibleOutput {
  let parsed: AnsibleJsonOutput | null = null
  let outputUnparseable = false
  if (!rawOutput || !rawOutput.trim()) {
    outputUnparseable = true
  } else {
    try {
      parsed = JSON.parse(rawOutput) as AnsibleJsonOutput
    } catch {
      parsed = null
      outputUnparseable = true
    }
  }

  const taskResults: ServerSetupTaskResult[] = []
  for (const play of parsed?.plays ?? []) {
    for (const task of play.tasks ?? []) {
      const name = task.task?.name ?? ''
      const hostResults = Object.values(task.hosts ?? {})
      // A task with neither a name nor any host result carries no information.
      if (!name && hostResults.length === 0) continue
      taskResults.push(taskResultFrom(name || 'task', hostResults))
    }
  }

  return { taskResults, outputUnparseable }
}

