import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { createHash } from 'crypto'
import { Readable } from 'stream'
import { performance } from 'perf_hooks'
import { verifyBackupExport } from '../../src/backup/backup-verifier'

const runId = 'export-test'
const attemptId = '113f0496-349c-4df0-8802-d12c535fc217'
const root = `daily/${runId}/${attemptId}/`
const retainUntil = '2099-01-01T00:00:00.000Z'
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const descriptor = (name: string, data: Buffer) => ({ bucket: 'backup-bucket', key: root + name, versionId: 'version-' + name, bytes: data.length, sha256: digest(data), retainUntil })
const limits = () => ({ maxObjects: 10, maxTotalCiphertextBytes: 10000, minimumRetainUntil: new Date('2098-01-01'), timeoutMs: 10000 })

describe('verifyBackupExport', () => {
  const s3 = mockClient(S3Client)
  let bodies: Map<string, Buffer>
  let metadata: Map<string, ReturnType<typeof descriptor>>
  let manifest: ReturnType<typeof descriptor>
  const reference = () => ({ runId, attemptId, objectCount: 1, manifest })
  beforeEach(() => {
    s3.reset()
    const data = Buffer.from('opaque data ciphertext'); const catalog = Buffer.from('opaque catalog ciphertext')
    const entry = descriptor('000000.enc', data); const catalogEntry = descriptor('catalog.enc', catalog)
    const index = Buffer.from(JSON.stringify({ version: 1, runId, attemptId, completedAt: new Date().toISOString(), objects: [{ id: '000000', ...entry }], catalog: catalogEntry }))
    manifest = descriptor('manifest.json', index)
    bodies = new Map([[entry.key, data], [catalogEntry.key, catalog], [manifest.key, index]])
    metadata = new Map([entry, catalogEntry, manifest].map(item => [item.key, item]))
    const headers = (key: string) => {
      const item = metadata.get(key)!
      return { ContentLength: item.bytes, VersionId: item.versionId, ObjectLockMode: 'COMPLIANCE' as const, ObjectLockRetainUntilDate: new Date(item.retainUntil) }
    }
    s3.on(HeadObjectCommand).callsFake(input => headers(input.Key))
    s3.on(GetObjectCommand).callsFake(input => ({ ...headers(input.Key), Body: Readable.from([bodies.get(input.Key)!]) }))
  })
  afterAll(() => s3.restore())
  const verify = (signal?: AbortSignal) => verifyBackupExport(new S3Client({ region: 'us-east-1' }), reference(), limits(), signal)

  it('checks manifest, encrypted catalog and all data with their exact versions, without writes', async () => {
    const result = await verify()
    expect(result).toMatchObject({ version: 1, runId, attemptId, objectCount: 1, checkedObjects: 3, ciphertextBytes: [...bodies.values()].reduce((n, b) => n + b.length, 0), minimumRetainUntil: retainUntil })
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true)
    for (const call of s3.calls()) {
      expect(call.args[0] instanceof HeadObjectCommand || call.args[0] instanceof GetObjectCommand).toBe(true)
      const input = call.args[0].input as { Key: string; VersionId: string }
      expect(input.VersionId).toBe(metadata.get(input.Key)!.versionId)
    }
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(3)
  })
  it.each(['manifest', 'catalog', 'data'])('rejects corrupt %s bytes', async kind => {
    const key = root + (kind === 'manifest' ? 'manifest.json' : kind === 'catalog' ? 'catalog.enc' : '000000.enc')
    const changed = Buffer.from(bodies.get(key)!); changed[0] ^= 1; bodies.set(key, changed)
    await expect(verify()).rejects.toThrow('BACKUP_VERIFY_DIGEST_MISMATCH')
    if (kind === 'manifest') expect(s3.commandCalls(GetObjectCommand)).toHaveLength(1)
  })
  it.each(['version', 'retention', 'mode', 'size', 'deleted'])('rejects wrong HEAD %s before reading content', async kind => {
    const headers: any = { ContentLength: manifest.bytes, VersionId: manifest.versionId, ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(retainUntil) }
    if (kind === 'version') headers.VersionId = 'other'
    if (kind === 'retention') headers.ObjectLockRetainUntilDate = new Date('2098-06-01')
    if (kind === 'mode') headers.ObjectLockMode = 'GOVERNANCE'
    if (kind === 'size') headers.ContentLength++
    if (kind === 'deleted') headers.DeleteMarker = true
    s3.on(HeadObjectCommand).resolves(headers)
    await expect(verify()).rejects.toThrow('BACKUP_VERIFY_OBJECT_MISMATCH')
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0)
  })
  it('closes a GET body when its version does not match', async () => {
    const body = Readable.from([bodies.get(manifest.key)!])
    s3.on(GetObjectCommand).resolves({ Body: body as any, ContentLength: manifest.bytes, VersionId: 'other' })
    await expect(verify()).rejects.toThrow('BACKUP_VERIFY_OBJECT_MISMATCH')
    expect(body.destroyed).toBe(true)
  })
  it.each([-1, 1])('rejects a stream with a wrong byte count (%s)', async change => {
    const data = bodies.get(manifest.key)!
    bodies.set(manifest.key, change < 0 ? data.subarray(1) : Buffer.concat([data, Buffer.from('x')]))
    await expect(verify()).rejects.toThrow('BACKUP_VERIFY_OBJECT_MISMATCH')
  })
  it('sanitizes provider errors and never treats missing objects as success', async () => {
    s3.on(GetObjectCommand).rejects(new Error('NoSuchVersion credential secret-marker'))
    await expect(verify()).rejects.toThrow(/^BACKUP_VERIFY_READ_FAILED$/)
  })
  it('validates the saved receipt before any storage request', async () => {
    manifest.bytes = 17 * 1024 * 1024
    await expect(verify()).rejects.toThrow('BACKUP_VERIFY_MANIFEST_INVALID')
    expect(s3.calls()).toHaveLength(0)
  })
  it('aborts a stalled stream and closes it', async () => {
    const controller = new AbortController(); const body = new Readable({ read() {} })
    s3.on(GetObjectCommand).callsFake(() => { setImmediate(() => controller.abort()); return { Body: body, ContentLength: manifest.bytes, VersionId: manifest.versionId, ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(retainUntil) } })
    await expect(verify(controller.signal)).rejects.toThrow('BACKUP_VERIFY_ABORTED')
    expect(body.destroyed).toBe(true)
  })
  it('enforces its deadline even while waiting for body data', async () => {
    const body = new Readable({ read() {} })
    s3.on(GetObjectCommand).resolves({ Body: body as any, ContentLength: manifest.bytes, VersionId: manifest.versionId, ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(retainUntil) })
    await expect(verifyBackupExport(new S3Client({ region: 'us-east-1' }), reference(), { ...limits(), timeoutMs: 10 })).rejects.toThrow('BACKUP_VERIFY_TIMEOUT')
    expect(body.destroyed).toBe(true)
  })
  it('does not contact storage when already cancelled', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(verify(controller.signal)).rejects.toThrow('BACKUP_VERIFY_ABORTED')
    expect(s3.calls()).toHaveLength(0)
  })
  it('does not rely on the timer callback running before an elapsed deadline is noticed', async () => {
    s3.on(HeadObjectCommand).callsFake(input => {
      const item = metadata.get(input.Key)!
      const end = performance.now() + 5
      while (performance.now() < end) { /* simulate synchronous SDK work delaying timers */ }
      return { ContentLength: item.bytes, VersionId: item.versionId, ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: new Date(retainUntil) }
    })
    await expect(verifyBackupExport(new S3Client({ region: 'us-east-1' }), reference(), { ...limits(), timeoutMs: 1 })).rejects.toThrow('BACKUP_VERIFY_TIMEOUT')
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0)
  })

})
