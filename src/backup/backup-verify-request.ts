import { validateBackupStorageConfiguration, type BackupStorageConfiguration } from './backup-storage-client'
import { validateBackupVerificationReference, type BackupVerificationReference } from './backup-verification-manifest'
import type { BackupVerificationOptions } from './backup-verifier'

export interface BackupVerifyRequest {
  verificationId: string
  awsAccountId: string
  region: string
  destination: BackupStorageConfiguration & { bucket: string; prefix: string }
  reference: BackupVerificationReference
  limits: BackupVerificationOptions
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}

/** Validate the command and its saved receipt before resolving any credentials. */
export function parseBackupVerifyRequest(input: unknown): BackupVerifyRequest {
  try {
    if (!record(input) || !only(input, ['verificationId', 'awsAccountId', 'region', 'destination', 'reference', 'limits']) ||
      typeof input.verificationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.verificationId) ||
      typeof input.awsAccountId !== 'string' || typeof input.region !== 'string' ||
      !record(input.destination) || !record(input.reference) || !record(input.limits)) throw new Error()
    const destination = input.destination
    if (!only(destination, ['provider', 'endpoint', 'region', 'writeCredentialSecretArn', 'bucket', 'prefix']) ||
      !['provider', 'endpoint', 'region', 'writeCredentialSecretArn', 'bucket', 'prefix'].every(key => typeof destination[key] === 'string') ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(destination.bucket as string) ||
      Buffer.byteLength(destination.prefix as string) > 512 || /[\x00-\x1f\x7f]/.test(destination.prefix as string)) throw new Error()
    const storage = destination as unknown as BackupVerifyRequest['destination']
    validateBackupStorageConfiguration(storage, { accountId: input.awsAccountId, region: input.region })
    const raw = input.limits
    if (!only(raw, ['maxObjects', 'maxTotalCiphertextBytes', 'minimumRetainUntil', 'timeoutMs']) ||
      typeof raw.minimumRetainUntil !== 'string' || !Number.isFinite(Date.parse(raw.minimumRetainUntil)) ||
      new Date(raw.minimumRetainUntil).toISOString() !== raw.minimumRetainUntil ||
      typeof raw.timeoutMs !== 'number' || !Number.isSafeInteger(raw.timeoutMs) || raw.timeoutMs < 1 || raw.timeoutMs > 21600000 ||
      !only(input.reference, ['runId', 'attemptId', 'objectCount', 'manifest'])) throw new Error()
    const limits: BackupVerificationOptions = {
      maxObjects: raw.maxObjects as number, maxTotalCiphertextBytes: raw.maxTotalCiphertextBytes as number,
      minimumRetainUntil: new Date(raw.minimumRetainUntil), timeoutMs: raw.timeoutMs,
    }
    const reference = validateBackupVerificationReference(input.reference as unknown as BackupVerificationReference, limits, new Date())
    const prefix = `${storage.prefix}${storage.prefix && !storage.prefix.endsWith('/') ? '/' : ''}`
    if (reference.manifest.bucket !== storage.bucket ||
      reference.manifest.key !== `${prefix}${reference.runId}/${reference.attemptId}/manifest.json` ||
      reference.manifest.bytes > limits.maxTotalCiphertextBytes) throw new Error()
    return { verificationId: input.verificationId, awsAccountId: input.awsAccountId, region: input.region,
      destination: { ...storage }, reference, limits }
  } catch { throw new Error('BACKUP_INVALID_REQUEST') }
}
