import type { S3Client } from '@aws-sdk/client-s3'
import { errorResult, successResult, type CommandResult } from '../types'
import { parseBackupExportRequest } from './backup-export-request'
import { createBackupResourceClient } from './backup-resource-client'
import { resolveBackupResources } from './backup-resource-selection'
import { loadBackupExportConfiguration } from './backup-source-secrets'
import { createBackupStorageClient } from './backup-storage-client'
import { enumerateBackupExportSources } from './backup-export-sources'
import { writeBackupExport } from './backup-export-writer'

const SAFE_ERRORS = new Set([
  'BACKUP_INVALID_REQUEST', 'BACKUP_AWS_ACCOUNT_MISMATCH', 'BACKUP_EXPORT_INVALID_SELECTION',
  'BACKUP_EXPORT_SELECTION_EMPTY', 'BACKUP_EXPORT_SELECTION_CHANGED', 'BACKUP_EXPORT_NO_LOGICAL_TARGETS',
  'BACKUP_EXPORT_RESOURCE_LIMIT', 'BACKUP_EXPORT_PAGINATION_FAILED', 'BACKUP_EXPORT_ENGINE_UNSUPPORTED',
  'BACKUP_SOURCE_INVALID_CONFIGURATION', 'BACKUP_SOURCE_SECRET_UNAVAILABLE',
  'BACKUP_STORAGE_CREDENTIALS_UNAVAILABLE', 'BACKUP_EXPORT_SIZE_LIMIT', 'BACKUP_EXPORT_INVALID_SOURCE',
  'BACKUP_EXPORT_ABORTED', 'BACKUP_EXPORT_TIMEOUT', 'BACKUP_UPLOAD_CLEANUP_FAILED',
  'BACKUP_DUMP_CLEANUP_FAILED', 'BACKUP_OBJECT_LOCK_REQUIRED', 'BACKUP_OBJECT_VERIFICATION_FAILED',
])

/** No credential, plaintext, or arbitrary provider error is returned to the API. */
export async function executeBackupExport(payload: unknown, enabled: boolean, commandId?: string): Promise<CommandResult> {
  if (enabled !== true) return errorResult('BACKUP_CAPABILITY_DISABLED')
  let aws: ReturnType<typeof createBackupResourceClient> | undefined
  let storage: S3Client | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const controller = new AbortController()
  const check = (): void => { if (controller.signal.aborted) throw new Error('BACKUP_EXPORT_TIMEOUT') }
  try {
    const request = parseBackupExportRequest(payload)
    if (!commandId || request.runId !== commandId) throw new Error('BACKUP_INVALID_REQUEST')
    timer = setTimeout(() => { timedOut = true; controller.abort() }, request.limits.timeoutMs)
    const context = { accountId: request.awsAccountId, region: request.region }
    aws = createBackupResourceClient(context, controller.signal)
    const selection = await resolveBackupResources(context, request.targets, aws, controller.signal)
    check()
    const configuration = await loadBackupExportConfiguration(request.exportConfigurationSecretArn, context, controller.signal)
    check()
    storage = await createBackupStorageClient(request.destination, context, controller.signal)
    check()
    const sourceClient = aws
    const receipt = await writeBackupExport(storage,
      signal => enumerateBackupExportSources(context, selection.resources, configuration, sourceClient,
        { ...request.limits, runId: request.runId, exportTime: request.exportTime }, signal),
      { ...request.limits, runId: request.runId, bucket: request.destination.bucket, prefix: request.destination.prefix,
        publicKeyPem: request.publicKeyPem, retainUntil: new Date(Date.now() + request.retentionDays * 86400000) },
      controller.signal,
    )
    check()
    return successResult({ version: 1, receipt, nativeOnlyTypes: selection.nativeOnlyTypes })
  } catch (error) {
    // Cleanup failures take precedence over timeout so operators can remove credentials.
    const code = error instanceof Error ? error.message : ''
    if (code === 'BACKUP_DUMP_CLEANUP_FAILED' || code === 'BACKUP_UPLOAD_CLEANUP_FAILED') return errorResult(code)
    return errorResult(timedOut ? 'BACKUP_EXPORT_TIMEOUT' : SAFE_ERRORS.has(code) ? code : 'BACKUP_EXPORT_FAILED')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
    // Attempt both disposals; never let disposal errors escape to the generic logger.
    let cleanupFailed = false
    try { storage?.destroy() } catch { cleanupFailed = true }
    try { aws?.close() } catch { cleanupFailed = true }
    if (cleanupFailed) return errorResult('BACKUP_EXPORT_CLEANUP_FAILED')
  }
}
