import { S3Client } from '@aws-sdk/client-s3'
import { createHash, generateKeyPairSync } from 'crypto'
import { writeBackupExport, type BackupExportSource } from '../../src/backup/backup-export-writer'
import { uploadLockedBackup } from '../../src/backup/backup-upload'

jest.mock('../../src/backup/backup-upload', () => ({ uploadLockedBackup: jest.fn() }))
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const options = () => ({ runId: 'command-123', bucket: 'tenant-backup', prefix: 'daily/', publicKeyPem, retainUntil: new Date('2099-01-01'), maxObjectBytes: 1024, maxTotalBytes: 2048, maxObjects: 10, timeoutMs: 10000 })
const source = (name: string, value: string): BackupExportSource => ({ resourceArn: 'arn:aws:s3:::private-source', name, format: 's3-object', open: async function* () { yield Buffer.from(value) } })
async function* sources(...items: BackupExportSource[]) { yield* items }

describe('backup export writer', () => {
  const client = {} as S3Client
  const writes: { key: string; body: Buffer }[] = []
  beforeEach(() => {
    jest.resetAllMocks(); writes.length = 0
    jest.mocked(uploadLockedBackup).mockImplementation(async (_client, input, target) => {
      const parts: Buffer[] = []; for await (const bytes of input) parts.push(Buffer.from(bytes))
      const body = Buffer.concat(parts); writes.push({ key: target.key, body })
      return { bucket: target.bucket, key: target.key, versionId: `version-${writes.length}`, bytes: body.length, sha256: createHash('sha256').update(body).digest('hex'), retainUntil: target.retainUntil.toISOString() }
    })
  })
  it('encrypts data and source catalog, then publishes the manifest last', async () => {
    const result = await writeBackupExport(client, () => sources(source('sensitive/key', 'sensitive data')), options())
    expect(writes).toHaveLength(3)
    expect(writes[0].body.subarray(0, 8).toString()).toBe('BYOBKP01')
    expect(writes[1].body.subarray(0, 8).toString()).toBe('BYOBKP01')
    const manifest = JSON.parse(writes[2].body.toString())
    expect(manifest).toMatchObject({ version: 1, runId: 'command-123', objects: [{ id: '000000', versionId: 'version-1' }], catalog: { versionId: 'version-2' } })
    expect(writes.every((w) => !w.body.includes(Buffer.from('sensitive')))).toBe(true)
    expect(result).toMatchObject({ runId: 'command-123', objectCount: 1, plaintextBytes: 14, manifest: { versionId: 'version-3' } })
    expect(result.manifest.sha256).toBe(createHash('sha256').update(writes[2].body).digest('hex'))
  })
  it('does not publish a success manifest when a later source fails', async () => {
    const broken = { ...source('b', ''), open: async function* () { yield Buffer.from('partial'); throw new Error('private credentials') } }
    await expect(writeBackupExport(client, () => sources(source('a', 'ok'), broken), options())).rejects.toThrow(/^BACKUP_EXPORT_FAILED$/)
    expect(writes).toHaveLength(1)
    expect(writes.some((w) => w.key.endsWith('manifest.json'))).toBe(false)
  })
  it('enforces the total plaintext limit across objects', async () => {
    await expect(writeBackupExport(client, () => sources(source('a', '123'), source('b', '456')), { ...options(), maxTotalBytes: 5 })).rejects.toThrow('BACKUP_EXPORT_SIZE_LIMIT')
    expect(writes).toHaveLength(1)
  })
  it('rejects invalid keys before any source or destination operation', async () => {
    const enumerate = jest.fn()
    await expect(writeBackupExport(client, enumerate, { ...options(), publicKeyPem: 'invalid' })).rejects.toThrow('BACKUP_UNSUPPORTED_PUBLIC_KEY')
    expect(enumerate).not.toHaveBeenCalled()
    expect(uploadLockedBackup).not.toHaveBeenCalled()
  })
  it('rejects duplicate source identities and never publishes a manifest', async () => {
    await expect(writeBackupExport(client, () => sources(source('a', 'one'), source('a', 'two')), options())).rejects.toThrow('BACKUP_EXPORT_INVALID_SOURCE')
    expect(writes).toHaveLength(1)
  })
  it('encrypts inventory without colliding with a real S3 key of the same name', async () => {
    const inventory: BackupExportSource = { ...source('resource-inventory.json', '{"private":"inventory"}'), format: 'resource-inventory' }
    const result = await writeBackupExport(client, () => sources(inventory, source('resource-inventory.json', 'data')), options())
    expect(result.objectCount).toBe(2)
    expect(writes).toHaveLength(4)
    expect(writes.every(write => !write.body.includes(Buffer.from('private')))).toBe(true)
  })
  it('allows an explicitly enumerated empty source set', async () => {
    const result = await writeBackupExport(client, () => sources(), options())
    expect(result.objectCount).toBe(0)
    expect(writes).toHaveLength(2)
  })
  it('uses a distinct attempt prefix on retries of the same command', async () => {
    const first = await writeBackupExport(client, () => sources(source('a', 'one')), options())
    const second = await writeBackupExport(client, () => sources(source('a', 'one')), options())
    expect(first.runId).toBe(second.runId)
    expect(first.manifest.key).not.toBe(second.manifest.key)
  })
  it('propagates the deadline signal to a waiting source', async () => {
    const waiting: BackupExportSource = { ...source('wait', ''), open: async function* (signal) {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    } }
    await expect(writeBackupExport(client, () => sources(waiting), { ...options(), timeoutMs: 20 })).rejects.toThrow('BACKUP_EXPORT_TIMEOUT')
    expect(writes).toHaveLength(0)
  })
})
