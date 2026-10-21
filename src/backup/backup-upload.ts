import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand,
  GetObjectLockConfigurationCommand, HeadObjectCommand, S3Client, UploadPartCommand,
} from '@aws-sdk/client-s3'
import { createHash } from 'crypto'

const PART_BYTES = 8 * 1024 * 1024
const SAFE_ERRORS = new Set([
  'BACKUP_OBJECT_LOCK_REQUIRED', 'BACKUP_OBJECT_VERIFICATION_FAILED',
  'BACKUP_EXPORT_ABORTED', 'BACKUP_EXPORT_SIZE_LIMIT', 'BACKUP_EXPORT_INVALID_CHUNK',
])
export interface LockedUploadTarget {
  bucket: string
  key: string
  retainUntil: Date
  maxBytes: number
}
export interface UploadedBackupObject {
  bucket: string
  key: string
  versionId: string
  bytes: number
  sha256: string
  retainUntil: string
}

/** Upload encrypted data or its public verification manifest. Never pass raw backup data. */
export async function uploadLockedBackup(
  client: S3Client,
  source: AsyncIterable<Uint8Array>,
  target: LockedUploadTarget,
  signal?: AbortSignal,
): Promise<UploadedBackupObject> {
  const { bucket, key, maxBytes } = target
  // Round up: S3 retention timestamps have second precision; never shorten retention.
  const retainUntil = new Date(Math.ceil(target.retainUntil.getTime() / 1000) * 1000)
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || !key || Buffer.byteLength(key) > 1024 ||
    !Number.isFinite(retainUntil.getTime()) || retainUntil.getTime() <= Date.now() ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 ** 36 + 65536) {
    throw new Error('BACKUP_UPLOAD_INVALID_TARGET')
  }
  const checkAbort = (): void => { if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED') }
  const options = { abortSignal: signal }
  let uploadId: string | undefined
  let completed = false
  try {
    checkAbort()
    const lock = await client.send(new GetObjectLockConfigurationCommand({ Bucket: bucket }), options)
    if (lock.ObjectLockConfiguration?.ObjectLockEnabled !== 'Enabled') throw new Error('BACKUP_OBJECT_LOCK_REQUIRED')
    checkAbort()
    const upload = await client.send(new CreateMultipartUploadCommand({
      Bucket: bucket, Key: key, ContentType: 'application/octet-stream',
      ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: retainUntil,
    }), options)
    uploadId = upload.UploadId
    if (!uploadId) throw new Error('BACKUP_UPLOAD_FAILED')
    checkAbort()
    let buffer = Buffer.allocUnsafe(PART_BYTES)
    let buffered = 0
    let total = 0
    const hash = createHash('sha256')
    const parts: { PartNumber: number; ETag: string }[] = []
    const sendPart = async (): Promise<void> => {
      checkAbort()
      const body = buffer.subarray(0, buffered)
      const partNumber = parts.length + 1
      if (partNumber > 10000) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
      const response = await client.send(new UploadPartCommand({
        Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber,
        Body: body, ContentLength: body.length,
        ContentMD5: createHash('md5').update(body).digest('base64'),
      }), options)
      if (!response.ETag) throw new Error('BACKUP_UPLOAD_FAILED')
      parts.push({ PartNumber: partNumber, ETag: response.ETag })
      // Each request retains a distinct buffer; retries never observe later data.
      buffer = Buffer.allocUnsafe(PART_BYTES)
      buffered = 0
    }
    for await (const chunk of source) {
      checkAbort()
      if (!(chunk instanceof Uint8Array)) throw new Error('BACKUP_EXPORT_INVALID_CHUNK')
      total += chunk.byteLength
      if (total > maxBytes) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const length = Math.min(PART_BYTES - buffered, chunk.byteLength - offset)
        buffer.set(chunk.subarray(offset, offset + length), buffered)
        buffered += length
        offset += length
        if (buffered === PART_BYTES) await sendPart()
      }
    }
    if (!total) throw new Error('BACKUP_UPLOAD_FAILED') // an encrypted envelope is never empty
    if (buffered) await sendPart()
    checkAbort()
    const result = await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts },
    }), options)
    completed = true
    const versionId = result.VersionId
    if (!versionId || versionId === 'null') throw new Error('BACKUP_OBJECT_VERIFICATION_FAILED')
    checkAbort()
    const stored = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }), options)
    if (stored.VersionId !== versionId || stored.ContentLength !== total || stored.ObjectLockMode !== 'COMPLIANCE' ||
      !stored.ObjectLockRetainUntilDate || !Number.isFinite(stored.ObjectLockRetainUntilDate.getTime()) ||
      stored.ObjectLockRetainUntilDate < retainUntil) throw new Error('BACKUP_OBJECT_VERIFICATION_FAILED')
    checkAbort()
    return { bucket, key, versionId, bytes: total, sha256: hash.digest('hex'), retainUntil: stored.ObjectLockRetainUntilDate.toISOString() }
  } catch (error) {
    if (uploadId && !completed) {
      try {
        // Do not reuse a cancelled signal; cleanup must still reach storage.
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), { abortSignal: AbortSignal.timeout(10000) })
      } catch {
        throw new Error('BACKUP_UPLOAD_CLEANUP_FAILED')
      }
    }
    // A producer may have failed to remove a local credential file. Preserve
    // that actionable fixed code even if cancellation triggered cleanup.
    if (error instanceof Error && error.message === 'BACKUP_DUMP_CLEANUP_FAILED') throw new Error('BACKUP_DUMP_CLEANUP_FAILED')
    if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
    throw new Error(error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'BACKUP_UPLOAD_FAILED')
  }
}
