import type { S3Client } from '@aws-sdk/client-s3'
import { performance } from 'perf_hooks'
import { errorResult, successResult, type CommandResult } from '../types'
import { parseBackupVerifyRequest } from './backup-verify-request'
import { createBackupStorageClient } from './backup-storage-client'
import { verifyBackupExport } from './backup-verifier'

const SAFE_ERRORS = new Set([
  'BACKUP_INVALID_REQUEST', 'BACKUP_AWS_ACCOUNT_MISMATCH', 'BACKUP_STORAGE_CREDENTIALS_UNAVAILABLE',
  'BACKUP_VERIFY_MANIFEST_INVALID', 'BACKUP_VERIFY_SIZE_LIMIT', 'BACKUP_VERIFY_OBJECT_MISMATCH',
  'BACKUP_VERIFY_DIGEST_MISMATCH', 'BACKUP_VERIFY_ABORTED', 'BACKUP_VERIFY_TIMEOUT', 'BACKUP_VERIFY_READ_FAILED',
])

/** Verify ciphertext only; the saved export ID is distinct from this command ID. */
export async function executeBackupVerify(payload: unknown, enabled: boolean, commandId?: string): Promise<CommandResult> {
  if (enabled !== true) return errorResult('BACKUP_CAPABILITY_DISABLED')
  let storage: S3Client | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let deadline = Infinity
  const controller = new AbortController()
  const expired = (): boolean => controller.signal.aborted || performance.now() >= deadline
  const check = (): void => {
    if (expired()) { controller.abort(); throw new Error('BACKUP_VERIFY_TIMEOUT') }
  }
  try {
    const request = parseBackupVerifyRequest(payload)
    if (!commandId || request.verificationId !== commandId) throw new Error('BACKUP_INVALID_REQUEST')
    deadline = performance.now() + request.limits.timeoutMs
    timer = setTimeout(() => controller.abort(), request.limits.timeoutMs)
    storage = await createBackupStorageClient(request.destination,
      { accountId: request.awsAccountId, region: request.region }, controller.signal)
    check()
    const verification = await verifyBackupExport(storage, request.reference,
      { ...request.limits, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())) }, controller.signal)
    check()
    return successResult({ verificationId: request.verificationId, verification })
  } catch (error) {
    const code = error instanceof Error ? error.message : ''
    return errorResult(expired() ? 'BACKUP_VERIFY_TIMEOUT' : SAFE_ERRORS.has(code) ? code : 'BACKUP_VERIFY_FAILED')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
    try { storage?.destroy() } catch { return errorResult('BACKUP_VERIFY_CLEANUP_FAILED') }
  }
}
