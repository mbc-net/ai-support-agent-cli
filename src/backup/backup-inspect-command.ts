import { errorResult, successResult, type CommandResult } from '../types'
import { createBackupInspectionClient } from './backup-aws-client'
import { parseBackupInspectionRequest } from './backup-inspect-request'
import { inspectBackup } from './backup-inspector'

const SAFE_ERRORS = new Set([
  'BACKUP_INVALID_REQUEST', 'BACKUP_AWS_ACCOUNT_MISMATCH',
  'BACKUP_PAGINATION_LIMIT', 'BACKUP_PLAN_CHANGED',
])

export async function executeBackupInspect(payload: unknown, enabled: boolean): Promise<CommandResult> {
  if (enabled !== true) return errorResult('BACKUP_CAPABILITY_DISABLED')
  let aws: ReturnType<typeof createBackupInspectionClient> | undefined
  try {
    const request = parseBackupInspectionRequest(payload)
    aws = createBackupInspectionClient(request.region)
    return successResult(await inspectBackup(request, aws))
  } catch (error) {
    // Provider/SDK errors can contain credential processes' stderr or arbitrary
    // resource metadata. Only fixed internal codes may leave the tenant host.
    return errorResult(error instanceof Error && SAFE_ERRORS.has(error.message)
      ? error.message : 'BACKUP_INSPECTION_FAILED')
  } finally {
    aws?.close()
  }
}
