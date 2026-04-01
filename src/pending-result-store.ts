import * as fs from 'fs'
import * as path from 'path'

import axios from 'axios'
import { getConfigDir } from './config-manager'
import { logger } from './logger'
import { ApiClient } from './api-client'
import type { CommandResult } from './types/command'
import { getErrorMessage } from './utils'

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
  const dir = getPendingDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
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
      savedAt: new Date().toISOString(),
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
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
      try {
        const filePath = path.join(dir, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        const data = JSON.parse(content) as PendingResult

        // Discard stale results (older than 1 hour)
        if (now - new Date(data.savedAt).getTime() > STALE_THRESHOLD_MS) {
          fs.unlinkSync(filePath)
          logger.debug(`Discarded stale pending result: ${data.commandId}`)
          continue
        }

        results.push(data)
      } catch {
        // Skip corrupted files
        try {
          fs.unlinkSync(path.join(dir, file))
        } catch { /* ignore */ }
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
      if (axios.isAxiosError(error) && error.response) {
        const status = error.response.status
        if (status !== 401 && status !== 403 && status >= 400 && status < 500) {
          removePendingResult(pending.commandId)
          logger.warn(`Discarded pending result ${pending.commandId}: server returned ${status}`)
          continue
        }
      }
      logger.warn(`Failed to submit pending result ${pending.commandId}: ${getErrorMessage(error)}`)
      // Leave the file for next restart attempt (unless stale cleanup removes it)
    }
  }
}
