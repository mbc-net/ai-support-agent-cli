import * as fs from 'fs'
import * as path from 'path'

import { getConfigDir } from './config-manager'
import { logger } from './logger'
import { ApiClient } from './api-client'
import { resolveInstanceId } from './replica-identity'
import type { CommandResult } from './types/command'
import { atomicWriteJson, axiosResponseStatus, ensureDir, getErrorMessage, isNonAuthClientError, nowIso } from './utils'
import { safeJsonParse } from './utils/json-parse'

const PENDING_RESULTS_DIR = 'pending-results'

/**
 * How long a pending result stays on disk before it is discarded.
 *
 * This MUST outlive the server-side command timeout. The API keeps a claimed
 * command in RUNNING for `MAX_COMMAND_EXECUTION_MS` (2 hours, see
 * api/src/common/constants/agent.constants.ts) before sweeping it to TIMEOUT.
 * The previous value was 1 hour, so the agent deleted the result a full hour
 * *before* the server stopped waiting for it — the job was then reported as
 * TIMEOUT even though it had completed successfully.
 */
export const PENDING_RESULT_STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000 // 3 hours

/**
 * How often to retry submitting results that are still on disk.
 *
 * A production API rollover takes roughly 85 seconds end to end (measured
 * 2026-08-16: stoppingAt 12:55:24 → stoppedAt 12:56:49). Retrying every minute
 * recovers an orphaned result within one deployment window.
 */
export const PENDING_RESULT_FLUSH_INTERVAL_MS = 60 * 1000

/**
 * Minimum age a pending result must reach before the *periodic* flush touches it.
 *
 * The main path writes the file BEFORE calling `submitResult` (agent-transport.ts),
 * precisely so a crash mid-submit cannot lose the result. That submit can take up
 * to ~35s (API_REQUEST_TIMEOUT 10s x API_MAX_RETRIES 3, plus backoff). Without this
 * guard the flush would pick up a file whose main-path submit is still in flight and
 * POST the same result in parallel — a race that did not exist when
 * `submitPendingResults()` only ran at process start.
 *
 * The server is idempotent (duplicate results are ignored), so this is about not
 * relying on that: a client-side race would show up as `duplicate_ignored` warnings
 * in production logs exactly when things are already going wrong.
 *
 * Only the very first registration of a process passes no minimum age (nothing can be
 * in flight yet). `registerAndStart()` also runs on token update and on eviction →
 * re-admission, where commands started earlier are still running, so those passes must
 * apply the guard too (see `ProjectAgent.hasRecoveredPendingResults`).
 */
export const PENDING_RESULT_MIN_RETRY_AGE_MS = 90 * 1000

export interface PendingResult {
  commandId: string
  agentId: string
  result: CommandResult
  apiUrl: string
  token: string
  tenantCode: string
  savedAt: string
  /**
   * 結果を生成したレプリカの instanceId。
   *
   * 再起動後の再送では、コマンドのクレーム主は「保存時のプロセス」のままである。
   * 現在のプロセスの instanceId（Pod 名は再作成で変わる）で送るとサーバー側の
   * フェンシングで 409 になり、実行済みの結果が破棄される。
   * 旧バージョンが書いたファイルには存在しないため optional。
   */
  instanceId?: string
  /**
   * 結果を生成した実行の指名世代（フェンシングトークン）。
   *
   * instanceId だけでは足りない。世代を送らないとサーバーは「指名を名乗らない
   * クライアント」として扱い、指名済みコマンドへの書き込みを拒否する（409）。
   * その 409 は「別レプリカに奪われた」と解釈されて結果が破棄されるため、
   * 同一 Pod のクラッシュ→再起動という最も典型的なケースで結果が失われる。
   */
  assignmentGeneration?: number
}

function getPendingDir(): string {
  return path.join(getConfigDir(), PENDING_RESULTS_DIR)
}

function ensurePendingDir(): void {
  ensureDir(getPendingDir())
}

export function savePendingResult(
  commandId: string,
  agentId: string,
  result: CommandResult,
  apiUrl: string,
  token: string,
  tenantCode: string,
  assignmentGeneration?: number,
): boolean {
  const filePath = path.join(getPendingDir(), `${commandId}.json`)
  try {
    ensurePendingDir()
    const data: PendingResult = {
      commandId,
      agentId,
      result,
      apiUrl,
      token,
      tenantCode,
      savedAt: nowIso(),
      instanceId: resolveInstanceId(),
      ...(assignmentGeneration !== undefined && { assignmentGeneration }),
    }
    atomicWriteJson(filePath, data)
    return true
  } catch (error) {
    // This is the only copy of a *completed* command's result. If it cannot be
    // written, the result is gone: the resend loop has nothing to resend and the
    // server will report the job as TIMEOUT after MAX_COMMAND_EXECUTION_MS.
    // `logger.debug` is gated behind --verbose, so this must never be debug.
    logger.error(
      `Failed to persist the result for ${commandId} to ${filePath}; ` +
        `it cannot be resent and will be lost: ${getErrorMessage(error)}`,
    )
    return false
  }
}

export function removePendingResult(commandId: string): void {
  try {
    const filePath = path.join(getPendingDir(), `${commandId}.json`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (error) {
    logger.debug(`Failed to remove pending result for ${commandId}: ${getErrorMessage(error)}`)
  }
}

export function loadPendingResults(): PendingResult[] {
  const dir = getPendingDir()
  if (!fs.existsSync(dir)) return []

  const results: PendingResult[] = []
  const now = Date.now()

  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const filePath = path.join(dir, file)
      try {
        const content = fs.readFileSync(filePath, 'utf-8')
        const data = safeJsonParse<PendingResult>(content)

        if (data === undefined) {
          // Skip corrupted files
          try { fs.unlinkSync(filePath) } catch { /* ignore */ }
          continue
        }

        // Discard stale results (see PENDING_RESULT_STALE_THRESHOLD_MS)
        if (now - new Date(data.savedAt).getTime() > PENDING_RESULT_STALE_THRESHOLD_MS) {
          fs.unlinkSync(filePath)
          // Dropping the result of a command that actually ran must be visible.
          // Reaching this point means the result failed to reach the API for the
          // whole retention window — the operator needs to know why.
          const ageMinutes = Math.round(
            (now - new Date(data.savedAt).getTime()) / 60_000,
          )
          logger.warn(
            `Discarded the result of ${data.commandId} after ${ageMinutes} minutes ` +
              `without reaching ${data.apiUrl} (savedAt=${data.savedAt})`,
          )
          continue
        }

        results.push(data)
      } catch (error) {
        // Skip files that cannot be read (e.g. permission errors).
        // This discards a completed command's result, so record it — a transient
        // fs error (EMFILE/EBUSY) here is indistinguishable from corruption, and
        // this path now runs every PENDING_RESULT_FLUSH_INTERVAL_MS rather than
        // once per process start.
        logger.warn(
          `Discarding unreadable pending result ${filePath}: ${getErrorMessage(error)}`,
        )
        try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      }
    }
  } catch (error) {
    logger.debug(`Failed to load pending results: ${getErrorMessage(error)}`)
  }

  return results
}

export async function submitPendingResults(
  options: { minAgeMs?: number } = {},
): Promise<void> {
  const minAgeMs = options.minAgeMs ?? 0
  const now = Date.now()
  const results = loadPendingResults().filter(
    (pending) =>
      minAgeMs === 0 || now - new Date(pending.savedAt).getTime() >= minAgeMs,
  )
  if (results.length === 0) return

  logger.info(`Submitting ${results.length} pending result(s)...`)

  for (const pending of results) {
    try {
      // クレーム主は保存時のプロセスであり、現在のプロセスではない。
      // 保存時の instanceId で送ることで、サーバー側のフェンシング条件
      // （claimedByInstanceId 一致）を満たす。
      // instanceId を持たない旧形式のファイルはレプリカ識別子を送らず、
      // フェンシング対象外（従来どおりの無条件更新）として扱う。
      // 指名を名乗るには instanceId と世代の**両方**が要る。世代を持たない
      // 旧形式のファイルは識別子ごと送らない（サーバーは instanceId だけの要求を
      // 400 で拒否する。フェンシングを迂回できないようにするため）。
      const hasAssignment =
        pending.instanceId !== undefined &&
        pending.assignmentGeneration !== undefined
      const client = new ApiClient(
        pending.apiUrl,
        pending.token,
        hasAssignment
          ? { instanceId: pending.instanceId }
          : { withoutReplicaIdentity: true },
      )
      if (hasAssignment) {
        client.restoreAssignment(
          pending.commandId,
          pending.assignmentGeneration as number,
        )
      }
      client.setTenantCode(pending.tenantCode)
      await client.submitResult(pending.commandId, pending.result, pending.agentId)
      removePendingResult(pending.commandId)
      logger.info(`Submitted pending result: ${pending.commandId}`)
    } catch (error) {
      // If the server returns 4xx other than 401/403, the command no longer exists or
      // is invalid — discard the pending result instead of retrying forever.
      // 401/403 are auth issues that may be resolved after re-login, so keep the file.
      if (isNonAuthClientError(error)) {
        const status = axiosResponseStatus(error)
        removePendingResult(pending.commandId)
        if (status === 409) {
          // フェンシングで弾かれた＝リース失効後に別レプリカがコマンドを奪って
          // 実行し直している。結果は既に確定済みなので破棄してよいが、
          // 「実行済みの結果を捨てた」ことは運用者に見える必要がある。
          logger.warn(
            `Discarded pending result ${pending.commandId}: ` +
              'the command was re-claimed by another replica (409)',
          )
        } else {
          logger.warn(`Discarded pending result ${pending.commandId}: server returned ${status}`)
        }
        continue
      }
      logger.warn(`Failed to submit pending result ${pending.commandId}: ${getErrorMessage(error)}`)
      // Leave the file for the next flush attempt (unless stale cleanup removes it)
    }
  }
}

/**
 * Guards against overlapping flushes.
 *
 * A submit that hangs (e.g. the API is mid-rollover and the connection stalls
 * until the 10s HTTP timeout) must not cause the next tick to start a second
 * pass over the same files — that would submit the same result twice and race
 * `removePendingResult` against itself.
 */
let flushInFlight = false

/**
 * Consecutive failures of the flush loop itself (not of an individual submit).
 * The loop is the last line of defence for results orphaned by an API rollover,
 * so a loop that keeps dying must be loud rather than silent.
 */
let consecutiveFlushFailures = 0

/** After this many consecutive failures the loop is reported as broken. */
const FLUSH_FAILURE_ALERT_THRESHOLD = 3

/**
 * Start retrying pending results on an interval.
 *
 * `submitPendingResults()` alone runs once per process start, but the agent is a
 * long-lived process that does NOT restart when the API is deployed. Without a
 * periodic retry, a result orphaned by a rollover stays on disk until the agent
 * happens to restart — which in practice means it is discarded by the stale
 * cleanup and the job is reported as TIMEOUT despite having succeeded.
 *
 * Returns the timer so the caller can stop it (see `ProjectAgent.stopWork()`).
 */
export function startPendingResultFlush(
  intervalMs: number = PENDING_RESULT_FLUSH_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    if (flushInFlight) return
    flushInFlight = true
    void submitPendingResults({ minAgeMs: PENDING_RESULT_MIN_RETRY_AGE_MS })
      .then(() => {
        consecutiveFlushFailures = 0
      })
      .catch((error) => {
        // submitPendingResults handles per-result errors itself; this only
        // catches an unexpected failure of the loop (e.g. the config dir cannot
        // be resolved). If the loop is dead, every orphaned result is lost once
        // it passes PENDING_RESULT_STALE_THRESHOLD_MS — so this is never debug.
        consecutiveFlushFailures += 1
        const message = `Pending result flush failed: ${getErrorMessage(error)}`
        if (consecutiveFlushFailures >= FLUSH_FAILURE_ALERT_THRESHOLD) {
          logger.error(
            `${message} (failed ${consecutiveFlushFailures} times in a row; ` +
              'completed command results are no longer being resent)',
          )
        } else {
          logger.warn(message)
        }
      })
      .finally(() => {
        flushInFlight = false
      })
  }, intervalMs)
  // Never keep the process alive just for this retry loop.
  timer.unref?.()
  return timer
}
