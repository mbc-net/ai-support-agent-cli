import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectLockConfigurationCommand, HeadObjectCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3'
import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from 'crypto'
import { mockClient } from 'aws-sdk-client-mock'
import { writeBackupExport } from '../../src/backup/backup-export-writer'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const config = { runId: 'command-456', bucket: 'tenant-backup', prefix: 'daily/', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), retainUntil: new Date('2099-01-01'), maxObjectBytes: 10000, maxTotalBytes: 10000, maxObjects: 10, timeoutMs: 10000 }
function decrypt(data: Buffer): Buffer {
  const end = 12 + data.readUInt32BE(8)
  const header = JSON.parse(data.subarray(12, end).toString())
  const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(header.wrappedKey, 'base64'))
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  cipher.setAAD(data.subarray(0, end)); cipher.setAuthTag(data.subarray(-16))
  return Buffer.concat([cipher.update(data.subarray(end, -16)), cipher.final()])
}
describe('export writer through real encryption and multipart upload', () => {
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } })
  const aws = mockClient(client)
  const stored = new Map<string, Buffer>()
  const pending = new Map<string, Buffer[]>()
  beforeEach(() => {
    aws.reset(); stored.clear(); pending.clear()
    aws.on(GetObjectLockConfigurationCommand).resolves({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })
    aws.on(CreateMultipartUploadCommand).callsFake((input) => { pending.set(input.Key!, []); return { UploadId: input.Key } })
    aws.on(UploadPartCommand).callsFake((input) => { pending.get(input.Key!)!.push(Buffer.from(input.Body as Uint8Array)); return { ETag: '"part"' } })
    aws.on(CompleteMultipartUploadCommand).callsFake((input) => { stored.set(input.Key!, Buffer.concat(pending.get(input.Key!)!)); return { VersionId: 'v1' } })
    aws.on(HeadObjectCommand).callsFake((input) => ({ VersionId: 'v1', ContentLength: stored.get(input.Key!)!.length, ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: config.retainUntil }))
    aws.on(AbortMultipartUploadCommand).resolves({})
  })
  afterAll(() => { aws.restore(); client.destroy() })
  it('produces a usable restoration catalog and exact ciphertext digests', async () => {
    const original = Buffer.from('private database content')
    const sources = async function* () { yield { resourceArn: 'arn:aws:s3:::private-source', name: 'private/key', format: 's3-object' as const, open: async function* () { yield original } } }
    const receipt = await writeBackupExport(client, sources, config)
    const bytes = stored.get(receipt.manifest.key)!
    const manifest = JSON.parse(bytes.toString())
    expect(receipt.manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(decrypt(stored.get(manifest.objects[0].key)!)).toEqual(original)
    const catalog = JSON.parse(decrypt(stored.get(manifest.catalog.key)!).toString())
    expect(catalog.objects).toEqual([{ id: manifest.objects[0].id, resourceArn: 'arn:aws:s3:::private-source', name: 'private/key', format: 's3-object' }])
    for (const object of [...manifest.objects, manifest.catalog]) {
      expect(object.bytes).toBe(stored.get(object.key)!.length)
      expect(object.sha256).toBe(createHash('sha256').update(stored.get(object.key)!).digest('hex'))
    }
    expect([...stored.values()].every((data) => !data.includes(original))).toBe(true)
    expect(aws.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(3)
  })
  it('preserves a producer cleanup failure through the upload layer', async () => {
    const sources = async function* () { yield { resourceArn: 'arn:aws:rds:us-east-1:123456789012:db:db', name: 'db', format: 'postgres-custom' as const, open: async function* () { yield Buffer.from('partial'); throw new Error('BACKUP_DUMP_CLEANUP_FAILED') } } }
    await expect(writeBackupExport(client, sources, config)).rejects.toThrow(/^BACKUP_DUMP_CLEANUP_FAILED$/)
    expect(aws.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
    expect(aws.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0)
  })
  it('aborts the current multipart and withholds the manifest on a total size overflow', async () => {
    const sources = async function* () {
      for (const name of ['first', 'second']) yield { resourceArn: 'arn:aws:s3:::source', name, format: 's3-object' as const, open: async function* () { yield Buffer.from('123') } }
    }
    await expect(writeBackupExport(client, sources, { ...config, maxTotalBytes: 5 })).rejects.toThrow(/^BACKUP_EXPORT_SIZE_LIMIT$/)
    expect(aws.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1)
    expect(aws.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
    expect([...stored.keys()].some((key) => key.endsWith('manifest.json'))).toBe(false)
  })
  it('preserves producer cleanup failure even if cancellation triggered it', async () => {
    const controller = new AbortController()
    const sources = async function* () { yield { resourceArn: 'arn:aws:rds:us-east-1:123456789012:db:db', name: 'db', format: 'postgres-custom' as const, open: async function* () { yield Buffer.from('partial'); controller.abort(); throw new Error('BACKUP_DUMP_CLEANUP_FAILED') } } }
    await expect(writeBackupExport(client, sources, config, controller.signal)).rejects.toThrow(/^BACKUP_DUMP_CLEANUP_FAILED$/)
    expect(aws.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
    expect(aws.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(0)
  })
})
