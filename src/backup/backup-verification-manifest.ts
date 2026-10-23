import type { BackupExportManifest, BackupExportReceipt } from './backup-export-writer'
import type { UploadedBackupObject } from './backup-upload'

export type BackupVerificationReference = Pick<BackupExportReceipt, 'runId' | 'attemptId' | 'objectCount' | 'manifest'>
export interface BackupVerificationLimits {
  maxObjects: number
  maxTotalCiphertextBytes: number
  minimumRetainUntil: Date
}
const invalid = (): never => { throw new Error('BACKUP_VERIFY_MANIFEST_INVALID') }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid()
}
function integer(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}

function metadata(
  input: unknown, bucket: string, key: string, maxBytes: number,
  limits: BackupVerificationLimits, now: Date, id?: string,
): UploadedBackupObject {
  const item = record(input)
  fields(item, ['bucket', 'key', 'versionId', 'bytes', 'sha256', 'retainUntil', ...(id === undefined ? [] : ['id'])])
  if (item.bucket !== bucket || item.key !== key || Buffer.byteLength(key) > 1024 || /[\x00-\x1f\x7f]/.test(key) ||
    typeof item.versionId !== 'string' || !item.versionId || item.versionId === 'null' ||
    item.versionId.length > 1024 || /[\x00-\x1f\x7f]/.test(item.versionId) ||
    !integer(item.bytes, maxBytes) || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
    !iso(item.retainUntil) || Date.parse(item.retainUntil) <= now.getTime() ||
    Date.parse(item.retainUntil) < limits.minimumRetainUntil.getTime() ||
    (id !== undefined && item.id !== id)) invalid()
  return { bucket, key, versionId: item.versionId as string,
    bytes: item.bytes as number, sha256: item.sha256 as string, retainUntil: item.retainUntil as string }
}

/** Validate and snapshot the saved reference before contacting any storage endpoint. */
export function validateBackupVerificationReference(
  input: BackupVerificationReference, limits: BackupVerificationLimits, now: Date,
): BackupVerificationReference {
  const expected = record(input)
  const manifest = record(expected.manifest)
  if (!integer(limits.maxObjects, 10000) || !integer(limits.maxTotalCiphertextBytes, 2 ** 41) ||
    !(limits.minimumRetainUntil instanceof Date) || !Number.isFinite(limits.minimumRetainUntil.getTime()) ||
    !(now instanceof Date) || !Number.isFinite(now.getTime()) ||
    typeof expected.runId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(expected.runId) ||
    typeof expected.attemptId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(expected.attemptId) ||
    !integer(expected.objectCount, limits.maxObjects) || typeof manifest.key !== 'string' ||
    (manifest.key !== `${expected.runId}/${expected.attemptId}/manifest.json` &&
      !manifest.key.endsWith(`/${expected.runId}/${expected.attemptId}/manifest.json`)) ||
    typeof manifest.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(manifest.bucket)) invalid()
  return { runId: expected.runId as string, attemptId: expected.attemptId as string, objectCount: expected.objectCount as number,
    manifest: metadata(manifest, manifest.bucket as string, manifest.key as string, 16 * 1024 * 1024, limits, now) }
}

/** Validate an untrusted public manifest against a separately saved receipt before
 * following any references. This checks metadata, not ciphertext or restorability.
 */
export function parseBackupVerificationManifest(
  input: unknown,
  reference: BackupVerificationReference,
  limits: BackupVerificationLimits,
  now: Date,
): BackupExportManifest {
  const expected = validateBackupVerificationReference(reference, limits, now)
  const prefix = expected.manifest.key.slice(0, -'manifest.json'.length)
  const manifest = record(input)
  fields(manifest, ['version', 'runId', 'attemptId', 'completedAt', 'objects', 'catalog'])
  if (manifest.version !== 1 || manifest.runId !== expected.runId || manifest.attemptId !== expected.attemptId ||
    !iso(manifest.completedAt) || Date.parse(manifest.completedAt) > now.getTime() + 300000 ||
    !Array.isArray(manifest.objects) || manifest.objects.length !== expected.objectCount) invalid()
  const catalog = metadata(manifest.catalog, expected.manifest.bucket, prefix + 'catalog.enc', 48 * 1024 * 1024 + 65536, limits, now)
  let total = expected.manifest.bytes + catalog.bytes
  const objects = (manifest.objects as unknown[]).map((item, index) => {
    const id = String(index).padStart(6, '0')
    const object = metadata(item, expected.manifest.bucket, `${prefix}${id}.enc`, 2 ** 36 + 65536, limits, now, id)
    total += object.bytes
    return { id, ...object }
  })
  if (total > limits.maxTotalCiphertextBytes) throw new Error('BACKUP_VERIFY_SIZE_LIMIT')
  return { version: 1, runId: expected.runId, attemptId: expected.attemptId,
    completedAt: manifest.completedAt as string, objects, catalog }
}
