import { validateBackupPublicKey } from './backup-envelope'
import { parseBackupResourceTargets, type BackupResourceTarget } from './backup-resource-selection'
import { assertBackupSecretScope } from './backup-source-secrets'
import { validateBackupStorageConfiguration, type BackupStorageConfiguration } from './backup-storage-client'

export interface BackupExportRequest {
  runId: string
  awsAccountId: string
  region: string
  targets: BackupResourceTarget[]
  exportConfigurationSecretArn: string
  exportTime: Date
  publicKeyPem: string
  destination: BackupStorageConfiguration & { bucket: string; prefix: string }
  retentionDays: number
  limits: { maxObjects: number; maxObjectBytes: number; maxTotalBytes: number; timeoutMs: number }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function only(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)) }
function integer(value: unknown, max: number): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max }

/** Pure validation, before any credential lookup or source/destination operation. */
export function parseBackupExportRequest(input: unknown): BackupExportRequest {
  try {
    if (!object(input) || !only(input, ['runId', 'awsAccountId', 'region', 'targets', 'exportConfigurationSecretArn', 'exportTime', 'publicKeyPem', 'destination', 'retentionDays', 'limits']) ||
      typeof input.runId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.runId) ||
      typeof input.awsAccountId !== 'string' || !/^\d{12}$/.test(input.awsAccountId) ||
      typeof input.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(input.region) ||
      typeof input.exportConfigurationSecretArn !== 'string' || typeof input.publicKeyPem !== 'string' ||
      typeof input.exportTime !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.exportTime) ||
      !integer(input.retentionDays, 36500) || !object(input.destination) || !object(input.limits)) throw new Error()
    const context = { accountId: input.awsAccountId, region: input.region }
    const targets = parseBackupResourceTargets(context, input.targets)
    assertBackupSecretScope(input.exportConfigurationSecretArn, context)
    validateBackupPublicKey(input.publicKeyPem)
    const exportTime = new Date(input.exportTime)
    if (!Number.isFinite(exportTime.getTime()) || exportTime.toISOString() !== input.exportTime || exportTime.getTime() > Date.now()) throw new Error()
    const destination = input.destination
    if (!only(destination, ['provider', 'endpoint', 'region', 'writeCredentialSecretArn', 'bucket', 'prefix']) ||
      !['provider', 'endpoint', 'region', 'writeCredentialSecretArn', 'bucket', 'prefix'].every(key => typeof destination[key] === 'string') ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(destination.bucket as string) ||
      Buffer.byteLength(destination.prefix as string) > 512 || /[\x00-\x1f\x7f]/.test(destination.prefix as string)) throw new Error()
    const storage = destination as unknown as BackupExportRequest['destination']
    validateBackupStorageConfiguration(storage, context)
    const limits = input.limits
    if (!only(limits, ['maxObjects', 'maxObjectBytes', 'maxTotalBytes', 'timeoutMs']) ||
      !integer(limits.maxObjects, 10000) || !integer(limits.maxObjectBytes, 2 ** 36 - 32) ||
      !integer(limits.maxTotalBytes, 2 ** 40) || !integer(limits.timeoutMs, 21600000)) throw new Error()
    return {
      runId: input.runId, awsAccountId: input.awsAccountId, region: input.region, targets,
      exportConfigurationSecretArn: input.exportConfigurationSecretArn, exportTime, publicKeyPem: input.publicKeyPem,
      destination: { ...storage }, retentionDays: input.retentionDays,
      limits: { maxObjects: limits.maxObjects, maxObjectBytes: limits.maxObjectBytes, maxTotalBytes: limits.maxTotalBytes, timeoutMs: limits.timeoutMs },
    }
  } catch { throw new Error('BACKUP_INVALID_REQUEST') }
}
