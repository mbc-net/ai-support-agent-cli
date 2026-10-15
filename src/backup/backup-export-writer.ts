import type { S3Client } from '@aws-sdk/client-s3'
import { randomUUID } from 'crypto'
import { encryptBackupStream, validateBackupPublicKey } from './backup-envelope'
import { uploadLockedBackup, type UploadedBackupObject } from './backup-upload'

export type BackupExportFormat = 'postgres-custom' | 'mysql-sql' | 's3-object' | 'dynamodb-json-gzip' | 'dynamodb-manifest' | 'dynamodb-schema' | 'resource-inventory'
export interface BackupExportSource {
  resourceArn: string
  name: string
  format: BackupExportFormat
  open(signal: AbortSignal): AsyncIterable<Uint8Array>
}
export interface BackupExportWriterOptions {
  runId: string
  bucket: string
  prefix: string
  publicKeyPem: string
  retainUntil: Date
  maxObjectBytes: number
  maxTotalBytes: number
  maxObjects: number
  timeoutMs: number
}
export interface BackupExportManifest {
  version: 1
  runId: string
  attemptId: string
  completedAt: string
  objects: (UploadedBackupObject & { id: string })[]
  catalog: UploadedBackupObject
}
export interface BackupExportReceipt {
  runId: string
  attemptId: string
  objectCount: number
  plaintextBytes: number
  manifest: UploadedBackupObject
}
const MAX_CATALOG_BYTES = 48 * 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const SAFE_ERRORS = new Set([
  'BACKUP_EXPORT_SIZE_LIMIT', 'BACKUP_EXPORT_INVALID_SOURCE', 'BACKUP_EXPORT_ABORTED', 'BACKUP_EXPORT_TIMEOUT',
  'BACKUP_UPLOAD_CLEANUP_FAILED', 'BACKUP_DUMP_CLEANUP_FAILED', 'BACKUP_OBJECT_LOCK_REQUIRED',
  'BACKUP_OBJECT_VERIFICATION_FAILED',
])
async function* bufferSource(bytes: Buffer): AsyncGenerator<Buffer> { yield bytes }

/**
 * Commit protocol: data -> encrypted restoration catalog -> public manifest.
 * A receipt is returned only after the final manifest is retained and verified.
 * Failed attempts keep completed immutable objects but never publish success.
 * The caller must verify resource selection before returning an empty iterable.
 */
export async function writeBackupExport(
  client: S3Client,
  enumerate: (signal: AbortSignal) => AsyncIterable<BackupExportSource>,
  input: BackupExportWriterOptions,
  signal?: AbortSignal,
): Promise<BackupExportReceipt> {
  const config = { ...input, retainUntil: new Date(input.retainUntil.getTime()) }
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(config.runId) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) ||
    typeof config.prefix !== 'string' || Buffer.byteLength(config.prefix) > 512 || /[\x00-\x1f\x7f]/.test(config.prefix) ||
    !Number.isFinite(config.retainUntil.getTime()) || config.retainUntil.getTime() <= Date.now() ||
    !Number.isSafeInteger(config.maxObjectBytes) || config.maxObjectBytes < 1 || config.maxObjectBytes > 2 ** 36 - 32 ||
    !Number.isSafeInteger(config.maxTotalBytes) || config.maxTotalBytes < 1 || config.maxTotalBytes > 2 ** 40 ||
    !Number.isInteger(config.maxObjects) || config.maxObjects < 1 || config.maxObjects > 10000 ||
    !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 21600000) throw new Error('BACKUP_EXPORT_INVALID_CONFIGURATION')
  validateBackupPublicKey(config.publicKeyPem)
  const controller = new AbortController()
  let timedOut = false
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, config.timeoutMs)
  const check = (): void => {
    if (controller.signal.aborted) throw new Error(timedOut ? 'BACKUP_EXPORT_TIMEOUT' : 'BACKUP_EXPORT_ABORTED')
  }
  const attemptId = randomUUID()
  const prefix = `${config.prefix}${config.prefix && !config.prefix.endsWith('/') ? '/' : ''}${config.runId}/${attemptId}/`
  const objects: BackupExportManifest['objects'] = []
  const catalog: { id: string; resourceArn: string; name: string; format: BackupExportFormat }[] = []
  const identities = new Set<string>()
  let plaintextBytes = 0
  const encryptAndUpload = async (source: AsyncIterable<Uint8Array>, name: string, maxBytes: number) => {
    check()
    return uploadLockedBackup(client, encryptBackupStream(source, config.publicKeyPem, maxBytes, controller.signal), {
      bucket: config.bucket, key: prefix + name, retainUntil: config.retainUntil, maxBytes: maxBytes + 65536,
    }, controller.signal)
  }
  try {
    check()
    for await (const item of enumerate(controller.signal)) {
      check()
      // Snapshot descriptor fields; no credentials or arbitrary extra properties
      // are serialized into the encrypted restoration catalog.
      const { resourceArn, name, format, open } = item
      if (objects.length >= config.maxObjects) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
      if (typeof resourceArn !== 'string' || !resourceArn.startsWith('arn:') || resourceArn.length > 2048 ||
        typeof name !== 'string' || !name || Buffer.byteLength(name) > 1024 ||
        !['postgres-custom', 'mysql-sql', 's3-object', 'dynamodb-json-gzip', 'dynamodb-manifest', 'dynamodb-schema', 'resource-inventory'].includes(format) || typeof open !== 'function') throw new Error('BACKUP_EXPORT_INVALID_SOURCE')
      const identity = JSON.stringify([resourceArn, name, format])
      if (identities.has(identity)) throw new Error('BACKUP_EXPORT_INVALID_SOURCE')
      identities.add(identity)
      const id = String(objects.length).padStart(6, '0')
      async function* counted(): AsyncGenerator<Uint8Array> {
        for await (const chunk of open(controller.signal)) {
          check()
          if (!(chunk instanceof Uint8Array)) throw new Error('BACKUP_EXPORT_INVALID_SOURCE')
          plaintextBytes += chunk.byteLength
          if (plaintextBytes > config.maxTotalBytes) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
          yield chunk
        }
      }
      const stored = await encryptAndUpload(counted(), `${id}.enc`, config.maxObjectBytes)
      objects.push({ id, ...stored })
      catalog.push({ id, resourceArn, name, format })
    }
    check()
    const catalogBytes = Buffer.from(JSON.stringify({ version: 1, runId: config.runId, attemptId, objects: catalog }))
    if (catalogBytes.length > MAX_CATALOG_BYTES) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
    const storedCatalog = await encryptAndUpload(bufferSource(catalogBytes), 'catalog.enc', MAX_CATALOG_BYTES)
    const manifest: BackupExportManifest = { version: 1, runId: config.runId, attemptId, completedAt: new Date().toISOString(), objects, catalog: storedCatalog }
    const manifestBytes = Buffer.from(JSON.stringify(manifest))
    if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
    check()
    // This public index contains only opaque IDs and ciphertext verification
    // metadata. Source ARNs/names stay in the encrypted catalog above.
    const storedManifest = await uploadLockedBackup(client, bufferSource(manifestBytes), {
      bucket: config.bucket, key: prefix + 'manifest.json', retainUntil: config.retainUntil, maxBytes: MAX_MANIFEST_BYTES,
    }, controller.signal)
    check()
    return { runId: config.runId, attemptId, objectCount: objects.length, plaintextBytes, manifest: storedManifest }
  } catch (error) {
    // Cleanup failures must remain visible even when the deadline triggered them.
    if (error instanceof Error && ['BACKUP_UPLOAD_CLEANUP_FAILED', 'BACKUP_DUMP_CLEANUP_FAILED'].includes(error.message)) throw error
    check()
    throw new Error(error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'BACKUP_EXPORT_FAILED')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}
