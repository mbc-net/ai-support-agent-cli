import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'stream'

export interface BackupS3Object {
  bucket: string
  accountId: string
  key: string
  etag: string
  bytes: number
}
export interface BackupS3Selection {
  bucket: string
  accountId: string
  prefix: string
  maxObjects: number
  maxObjectBytes: number
}
const SAFE_ERRORS = new Set(['BACKUP_S3_PAGINATION_FAILED', 'BACKUP_S3_INVALID_RESPONSE', 'BACKUP_S3_OBJECT_LIMIT', 'BACKUP_S3_SOURCE_CHANGED', 'BACKUP_EXPORT_ABORTED'])
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
}
function fail(error: unknown, signal?: AbortSignal): never {
  checkAbort(signal)
  throw new Error(error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'BACKUP_S3_READ_FAILED')
}
function validOwner(bucket: string, accountId: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && /^\d{12}$/.test(accountId)
}
function validSize(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= 2 ** 36 - 32
}

/** Current object contents, not a bucket-wide point-in-time snapshot or version history. */
export async function* listBackupS3Objects(client: S3Client, input: BackupS3Selection, signal?: AbortSignal): AsyncGenerator<BackupS3Object> {
  const { bucket, accountId, prefix, maxObjects, maxObjectBytes } = input
  if (!validOwner(bucket, accountId) || typeof prefix !== 'string' || Buffer.byteLength(prefix) > 1024 ||
    !Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 100000 || !validSize(maxObjectBytes) || maxObjectBytes < 1) throw new Error('BACKUP_S3_INVALID_CONFIGURATION')
  let continuation: string | undefined
  const tokens = new Set<string>()
  let count = 0
  let previous: Buffer | undefined
  try {
    for (let page = 0; page < 10000; page++) {
      checkAbort(signal)
      const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, ExpectedBucketOwner: accountId, Prefix: prefix, EncodingType: 'url', MaxKeys: 1000, ContinuationToken: continuation }), { abortSignal: signal })
      checkAbort(signal)
      // General-purpose S3 buckets are lexicographically ordered. Reject
      // duplicates/out-of-order keys instead of writing an ambiguous manifest.
      for (const item of result.Contents ?? []) {
        const key = result.EncodingType === 'url' && typeof item.Key === 'string' ? decodeURIComponent(item.Key) : item.Key
        if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024 || !key.startsWith(prefix) ||
          typeof item.ETag !== 'string' || !item.ETag || item.ETag.length > 1024 || !validSize(item.Size!)) throw new Error('BACKUP_S3_INVALID_RESPONSE')
        const keyBytes = Buffer.from(key)
        if (previous && Buffer.compare(previous, keyBytes) >= 0) throw new Error('BACKUP_S3_INVALID_RESPONSE')
        previous = keyBytes
        if (++count > maxObjects || item.Size! > maxObjectBytes) throw new Error('BACKUP_S3_OBJECT_LIMIT')
        checkAbort(signal)
        yield { bucket, accountId, key, etag: item.ETag, bytes: item.Size! }
      }
      if (!result.IsTruncated) return
      continuation = result.NextContinuationToken
      if (!continuation || tokens.has(continuation)) throw new Error('BACKUP_S3_PAGINATION_FAILED')
      tokens.add(continuation)
    }
    throw new Error('BACKUP_S3_PAGINATION_FAILED')
  } catch (error) { fail(error, signal) }
}

/** The caller must use a tenant AWS client after the STS account gate. */
export async function* streamBackupS3Object(client: S3Client, input: BackupS3Object, signal?: AbortSignal): AsyncGenerator<Buffer> {
  const { bucket, accountId, key, etag, bytes } = input
  if (!validOwner(bucket, accountId) || typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024 ||
    typeof etag !== 'string' || !etag || etag.length > 1024 || !validSize(bytes)) throw new Error('BACKUP_S3_INVALID_CONFIGURATION')
  let body: Readable | undefined
  const abort = (): void => { body?.destroy(new Error('BACKUP_EXPORT_ABORTED')) }
  try {
    checkAbort(signal)
    const request = { Bucket: bucket, ExpectedBucketOwner: accountId, Key: key, IfMatch: etag }
    const head = await client.send(new HeadObjectCommand(request), { abortSignal: signal })
    checkAbort(signal)
    if (head.ETag !== etag || head.ContentLength !== bytes || head.DeleteMarker) throw new Error('BACKUP_S3_SOURCE_CHANGED')
    // A suspended/unversioned bucket's "null" version can be overwritten;
    // IfMatch is therefore required even when VersionId is present.
    const response = await client.send(new GetObjectCommand({ ...request, ...(head.VersionId ? { VersionId: head.VersionId } : {}) }), { abortSignal: signal })
    if (response.Body instanceof Readable) body = response.Body
    if (!body) throw new Error('BACKUP_S3_INVALID_RESPONSE')
    body.on('error', () => { /* async iteration handles errors; pre-iteration abort also needs a listener */ })
    checkAbort(signal)
    if (response.ETag !== etag || response.ContentLength !== bytes || response.DeleteMarker ||
      (head.VersionId && response.VersionId !== head.VersionId)) throw new Error('BACKUP_S3_SOURCE_CHANGED')
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let read = 0
    for await (const chunk of body) {
      checkAbort(signal)
      if (!(chunk instanceof Uint8Array)) throw new Error('BACKUP_S3_INVALID_RESPONSE')
      read += chunk.byteLength
      if (read > bytes) throw new Error('BACKUP_S3_SOURCE_CHANGED')
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    }
    checkAbort(signal)
    if (read !== bytes) throw new Error('BACKUP_S3_SOURCE_CHANGED')
  } catch (error) { fail(error, signal) }
  finally {
    signal?.removeEventListener('abort', abort)
    body?.destroy()
  }
}
