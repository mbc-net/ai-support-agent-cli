import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'

import { logger } from '../logger'

/**
 * Create a temporary file with secure permissions.
 * Returns the file path. Caller is responsible for cleanup.
 */
export function createSecureTempFile(content: string, prefix: string): string {
  const filename = `${prefix}-${crypto.randomBytes(16).toString('hex')}`
  const filepath = path.join(os.tmpdir(), filename)
  fs.writeFileSync(filepath, content, { mode: 0o600 })
  return filepath
}

/**
 * Delete a temporary file, logging a warning (instead of throwing) if the
 * deletion fails. Used by callers that generate secret-bearing temp files
 * (SSH keys, credential helper scripts) whose cleanup should never crash the
 * caller — a failed deletion is unfortunate but not fatal to the operation
 * that created the file.
 */
export function safeUnlink(filePath: string, warnMessage: string): void {
  try {
    fs.unlinkSync(filePath)
  } catch {
    logger.warn(warnMessage)
  }
}
