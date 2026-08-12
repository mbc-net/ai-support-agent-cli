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
const STALE_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour

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
): void {
  try {
    ensurePendingDir()
    const filePath = path.join(getPendingDir(), `${commandId}.json`)
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
  } catch (error) {
    logger.debug(`Failed to save pending result for ${commandId}: ${getErrorMessage(error)}`)
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

        // Discard stale results (older than 1 hour)
        if (now - new Date(data.savedAt).getTime() > STALE_THRESHOLD_MS) {
          fs.unlinkSync(filePath)
          logger.debug(`Discarded stale pending result: ${data.commandId}`)
          continue
        }

        results.push(data)
      } catch {
        // Skip files that cannot be read (e.g. permission errors)
        try { fs.unlinkSync(filePath) } catch { /* ignore */ }
      }
    }
  } catch (error) {
    logger.debug(`Failed to load pending results: ${getErrorMessage(error)}`)
  }

  return results
}

export async function submitPendingResults(): Promise<void> {
  const results = loadPendingResults()
  if (results.length === 0) return

  logger.info(`Found ${results.length} pending result(s) from previous session, submitting...`)

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
      // Leave the file for next restart attempt (unless stale cleanup removes it)
    }
  }
}
