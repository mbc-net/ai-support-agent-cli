import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectLockConfigurationCommand, HeadObjectCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3'
import { createHash } from 'crypto'
import { mockClient } from 'aws-sdk-client-mock'
import { uploadLockedBackup } from '../../src/backup/backup-upload'

async function* bytes(...chunks: Buffer[]) { yield* chunks }
const target = () => ({ bucket: 'tenant-backup', key: 'daily/run/object.enc', retainUntil: new Date('2099-01-01T00:00:00Z'), maxBytes: 20 * 1024 * 1024 })

describe('locked encrypted backup upload', () => {
  const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  const aws = mockClient(s3)
  beforeEach(() => {
    aws.reset()
    aws.on(GetObjectLockConfigurationCommand).resolves({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })
    aws.on(CreateMultipartUploadCommand).resolves({ UploadId: 'upload' })
    aws.on(UploadPartCommand).resolves({ ETag: 'part-etag' })
    aws.on(CompleteMultipartUploadCommand).resolves({ VersionId: 'version' })
    aws.on(AbortMultipartUploadCommand).resolves({})
    aws.on(HeadObjectCommand).resolves({ VersionId: 'version', ContentLength: 3, ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: target().retainUntil })
  })
  afterAll(() => { aws.restore(); s3.destroy() })

  it('sets compliance retention, checks the exact stored version and returns its ciphertext digest', async () => {
    const result = await uploadLockedBackup(s3, bytes(Buffer.from('abc')), target())
    expect(result).toEqual({ bucket: 'tenant-backup', key: 'daily/run/object.enc', versionId: 'version', bytes: 3, sha256: createHash('sha256').update('abc').digest('hex'), retainUntil: '2099-01-01T00:00:00.000Z' })
    expect(aws.commandCalls(CreateMultipartUploadCommand)[0].args[0].input).toMatchObject({ ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: target().retainUntil })
    expect(aws.commandCalls(HeadObjectCommand)[0].args[0].input).toEqual({ Bucket: target().bucket, Key: target().key, VersionId: 'version' })
    expect(aws.commandCalls(UploadPartCommand)[0].args[0].input).toMatchObject({ ContentLength: 3, ContentMD5: createHash('md5').update('abc').digest('base64') })
    expect(aws.commandCalls(AbortMultipartUploadCommand)).toHaveLength(0)
  })
  it('splits a large source chunk into bounded legal multipart bodies', async () => {
    const data = Buffer.alloc(9 * 1024 * 1024, 42)
    aws.on(HeadObjectCommand).resolves({ VersionId: 'version', ContentLength: data.length, ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: target().retainUntil })
    const result = await uploadLockedBackup(s3, bytes(data), target())
    const parts = aws.commandCalls(UploadPartCommand).map((call) => call.args[0].input)
    expect(parts).toHaveLength(2)
    expect(parts[0].ContentLength).toBeGreaterThanOrEqual(5 * 1024 * 1024)
    expect(parts.every((part) => part.ContentLength! <= 8 * 1024 * 1024)).toBe(true)
    expect(Buffer.concat(parts.map((part) => part.Body as Buffer)).equals(data)).toBe(true)
    expect(result.sha256).toBe(createHash('sha256').update(data).digest('hex'))
  })
  it('refuses an unlocked bucket before consuming the source', async () => {
    aws.on(GetObjectLockConfigurationCommand).resolves({})
    const source = { [Symbol.asyncIterator]: jest.fn() }
    await expect(uploadLockedBackup(s3, source, target())).rejects.toThrow('BACKUP_OBJECT_LOCK_REQUIRED')
    expect(source[Symbol.asyncIterator]).not.toHaveBeenCalled()
    expect(aws.commandCalls(CreateMultipartUploadCommand)).toHaveLength(0)
  })
  it.each([
    { ObjectLockMode: 'GOVERNANCE' }, { ObjectLockRetainUntilDate: new Date('2098-01-01') },
    { ContentLength: 2 }, { VersionId: 'other' },
  ])('does not accept unverified storage and never deletes completed objects (%#)', async (change) => {
    aws.on(HeadObjectCommand).resolves({ VersionId: 'version', ContentLength: 3, ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: target().retainUntil, ...change } as never)
    await expect(uploadLockedBackup(s3, bytes(Buffer.from('abc')), target())).rejects.toThrow('BACKUP_OBJECT_VERIFICATION_FAILED')
    expect(aws.commandCalls(AbortMultipartUploadCommand)).toHaveLength(0)
  })
  it('aborts on source or part failure without leaking error text', async () => {
    aws.on(UploadPartCommand).rejects(new Error('secret access key'))
    await expect(uploadLockedBackup(s3, bytes(Buffer.from('abc')), target())).rejects.toThrow(/^BACKUP_UPLOAD_FAILED$/)
    expect(aws.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
    expect(aws.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0)
  })
  it('aborts a size-limited upload and closes its input', async () => {
    let closed = false
    async function* source() { try { yield Buffer.from('abcd') } finally { closed = true } }
    await expect(uploadLockedBackup(s3, source(), { ...target(), maxBytes: 3 })).rejects.toThrow('BACKUP_EXPORT_SIZE_LIMIT')
    expect(closed).toBe(true)
    expect(aws.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
  })
  it('closes an upload when reading the encrypted source fails', async () => {
    async function* source() { yield Buffer.from('partial'); throw new Error('database password') }
    await expect(uploadLockedBackup(s3, source(), target())).rejects.toThrow(/^BACKUP_UPLOAD_FAILED$/)
    expect(aws.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
    expect(aws.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0)
  })
  it('recognizes cancellation while a part request is in flight', async () => {
    const controller = new AbortController()
    aws.on(UploadPartCommand).callsFake(async () => { controller.abort(); throw new Error('SDK abort details') })
    await expect(uploadLockedBackup(s3, bytes(Buffer.from('abc')), target(), controller.signal)).rejects.toThrow('BACKUP_EXPORT_ABORTED')
    expect(aws.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
  })
  it('reports cleanup failure rather than claiming no incomplete upload remains', async () => {
    aws.on(UploadPartCommand).rejects(new Error('failed'))
    aws.on(AbortMultipartUploadCommand).rejects(new Error('cleanup secret'))
    await expect(uploadLockedBackup(s3, bytes(Buffer.from('abc')), target())).rejects.toThrow(/^BACKUP_UPLOAD_CLEANUP_FAILED$/)
  })
  it('aborts with a fresh signal when the caller cancels after upload initiation', async () => {
    const controller = new AbortController()
    aws.on(CreateMultipartUploadCommand).callsFake(async () => { controller.abort(); return { UploadId: 'upload' } })
    await expect(uploadLockedBackup(s3, bytes(Buffer.from('abc')), target(), controller.signal)).rejects.toThrow('BACKUP_EXPORT_ABORTED')
    const call = aws.commandCalls(AbortMultipartUploadCommand)[0]
    expect(call).toBeDefined()
    expect(call.args[1]?.abortSignal?.aborted).toBe(false)
  })
})
