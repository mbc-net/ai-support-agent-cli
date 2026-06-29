import * as fs from 'fs'
import * as path from 'path'

import type { AxiosError } from 'axios'
import { getConfigDir } from './config-manager'
import { logger } from './logger'
import { ApiClient } from './api-client'
import type { CommandResult } from './types/command'
import { atomicWriteFile, ensureDir, getErrorMessage, isNonAuthClientError, nowIso } from './utils'
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
    }
    atomicWriteFile(filePath, JSON.stringify(data, null, 2))
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
      const client = new ApiClient(pending.apiUrl, pending.token)
      client.setTenantCode(pending.tenantCode)
      await client.submitResult(pending.commandId, pending.result, pending.agentId)
      removePendingResult(pending.commandId)
      logger.info(`Submitted pending result: ${pending.commandId}`)
    } catch (error) {
      // If the server returns 4xx other than 401/403, the command no longer exists or
      // is invalid — discard the pending result instead of retrying forever.
      // 401/403 are auth issues that may be resolved after re-login, so keep the file.
      if (isNonAuthClientError(error)) {
        const status = (error as AxiosError).response?.status
        removePendingResult(pending.commandId)
        logger.warn(`Discarded pending result ${pending.commandId}: server returned ${status}`)
        continue
      }
      logger.warn(`Failed to submit pending result ${pending.commandId}: ${getErrorMessage(error)}`)
      // Leave the file for next restart attempt (unless stale cleanup removes it)
    }
  }
}
