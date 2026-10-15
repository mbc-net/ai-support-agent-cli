import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { performance } from 'perf_hooks'
import type { UploadedBackupObject } from './backup-upload'
import { parseBackupVerificationManifest, validateBackupVerificationReference, type BackupVerificationLimits, type BackupVerificationReference } from './backup-verification-manifest'

export interface BackupVerificationOptions extends BackupVerificationLimits { timeoutMs: number }
export interface BackupVerificationResult {
  version: 1
  runId: string
  attemptId: string
  manifest: UploadedBackupObject
  objectCount: number
  checkedObjects: number
  ciphertextBytes: number
  minimumRetainUntil: string
  checkedAt: string
}
const SAFE_ERRORS = new Set([
  'BACKUP_VERIFY_MANIFEST_INVALID', 'BACKUP_VERIFY_SIZE_LIMIT', 'BACKUP_VERIFY_OBJECT_MISMATCH',
  'BACKUP_VERIFY_DIGEST_MISMATCH', 'BACKUP_VERIFY_ABORTED', 'BACKUP_VERIFY_TIMEOUT',
])

/** Read-only ciphertext verification. No decrypt, restore, writes, or private keys.
 * Caller owns the client. Only the bounded public manifest is buffered in memory.
 */
export async function verifyBackupExport(
  client: S3Client,
  input: BackupVerificationReference,
  options: BackupVerificationOptions,
  signal?: AbortSignal,
): Promise<BackupVerificationResult> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 21600000 ||
    !(options.minimumRetainUntil instanceof Date)) throw new Error('BACKUP_VERIFY_MANIFEST_INVALID')
  const config = { ...options, minimumRetainUntil: new Date(options.minimumRetainUntil.getTime()) }
  const expected = validateBackupVerificationReference(input, config, new Date())
  if (expected.manifest.bytes > config.maxTotalCiphertextBytes) throw new Error('BACKUP_VERIFY_SIZE_LIMIT')
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const deadline = performance.now() + config.timeoutMs
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, config.timeoutMs)
  const check = (): void => {
    if (!controller.signal.aborted && performance.now() >= deadline) { timedOut = true; controller.abort() }
    if (controller.signal.aborted) throw new Error(timedOut ? 'BACKUP_VERIFY_TIMEOUT' : 'BACKUP_VERIFY_ABORTED')
  }
  let ciphertextBytes = 0
  let checkedObjects = 0
  let minimumRetainUntil = Infinity
  const read = async (object: UploadedBackupObject, collect: boolean): Promise<Buffer | undefined> => {
    check()
    const request = { Bucket: object.bucket, Key: object.key, VersionId: object.versionId }
    const requestOptions = { abortSignal: controller.signal }
    const validateHeaders = (headers: {
      ContentLength?: number; VersionId?: string; DeleteMarker?: boolean;
      ObjectLockMode?: string; ObjectLockRetainUntilDate?: Date;
    }): number => {
      const until = headers.ObjectLockRetainUntilDate?.getTime()
      if (headers.ContentLength !== object.bytes || headers.VersionId !== object.versionId || headers.DeleteMarker ||
        headers.ObjectLockMode !== 'COMPLIANCE' || until === undefined || !Number.isFinite(until) ||
        until <= Date.now() || until < Date.parse(object.retainUntil) || until < config.minimumRetainUntil.getTime())
        throw new Error('BACKUP_VERIFY_OBJECT_MISMATCH')
      return until
    }
    const head = await client.send(new HeadObjectCommand(request), requestOptions)
    check()
    const headRetention = validateHeaders(head)
    let body: Readable | undefined
    const stop = (): void => { body?.destroy(new Error('BACKUP_VERIFY_ABORTED')) }
    try {
      const response = await client.send(new GetObjectCommand(request), requestOptions)
      if (response.Body instanceof Readable) body = response.Body
      if (!body) throw new Error('BACKUP_VERIFY_OBJECT_MISMATCH')
      body.on('error', () => { /* also handle an abort before iteration starts */ })
      check()
      const getRetention = validateHeaders(response)
      controller.signal.addEventListener('abort', stop, { once: true })
      if (controller.signal.aborted) stop()
      const hash = createHash('sha256')
      let readBytes = 0
      const chunks: Buffer[] = []
      for await (const chunk of body) {
        check()
        if (!(chunk instanceof Uint8Array)) throw new Error('BACKUP_VERIFY_OBJECT_MISMATCH')
        readBytes += chunk.byteLength
        ciphertextBytes += chunk.byteLength
        if (readBytes > object.bytes) throw new Error('BACKUP_VERIFY_OBJECT_MISMATCH')
        if (ciphertextBytes > config.maxTotalCiphertextBytes) throw new Error('BACKUP_VERIFY_SIZE_LIMIT')
        hash.update(chunk)
        if (collect) chunks.push(Buffer.from(chunk))
      }
      check()
      if (readBytes !== object.bytes) throw new Error('BACKUP_VERIFY_OBJECT_MISMATCH')
      if (hash.digest('hex') !== object.sha256) throw new Error('BACKUP_VERIFY_DIGEST_MISMATCH')
      checkedObjects++
      minimumRetainUntil = Math.min(minimumRetainUntil, headRetention, getRetention)
      return collect ? Buffer.concat(chunks) : undefined
    } finally {
      controller.signal.removeEventListener('abort', stop)
      body?.destroy()
    }
  }
  try {
    const bytes = await read(expected.manifest, true)
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes!)) }
    catch { throw new Error('BACKUP_VERIFY_MANIFEST_INVALID') }
    const manifest = parseBackupVerificationManifest(value, expected, config, new Date())
    await read(manifest.catalog, false)
    for (const object of manifest.objects) await read(object, false)
    check()
    const checkedAt = new Date()
    if (minimumRetainUntil <= checkedAt.getTime()) throw new Error('BACKUP_VERIFY_OBJECT_MISMATCH')
    return { version: 1, runId: expected.runId, attemptId: expected.attemptId, manifest: expected.manifest,
      objectCount: manifest.objects.length, checkedObjects, ciphertextBytes,
      minimumRetainUntil: new Date(minimumRetainUntil).toISOString(), checkedAt: checkedAt.toISOString() }
  } catch (error) {
    check()
    throw new Error(error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'BACKUP_VERIFY_READ_FAILED')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}
