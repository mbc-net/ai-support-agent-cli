import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, GetObjectLockConfigurationCommand, HeadObjectCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3'
import { createHash, generateKeyPairSync } from 'crypto'
import { Readable } from 'stream'
import { gzipSync } from 'zlib'
import { mockClient } from 'aws-sdk-client-mock'
import { enumerateDynamoBackupSources } from '../../src/backup/backup-dynamodb-source'
import { writeBackupExport } from '../../src/backup/backup-export-writer'

const context = { accountId: '123456789012', region: 'ap-northeast-1' }
const tableArn = 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/app'
const directory = 'backup/run/AWSDynamoDB/01234567890123-abcdef12/'
const completed = { tableArn, tableId: '12345678-1234-1234-1234-123456789012', exportArn: `${tableArn}/export/01234567890123-abcdef12`, exportTime: '2026-01-01T00:00:00.000Z', bucket: 'tenant-staging', prefix: 'backup/run', manifestKey: `${directory}manifest-summary.json`, itemCount: 1 }
const dataKey = `${directory}data/datafile.json.gz`
const data = gzipSync(Buffer.from('{"Item":{"id":{"S":"test"}}}\n'))
const file = () => ({ dataFileS3Key: dataKey, itemCount: 1, etag: createHash('md5').update(data).digest('hex'), md5Checksum: createHash('md5').update(data).digest('base64') })
const summary = () => ({ version: '2020-06-30', tableArn, tableId: completed.tableId, exportArn: completed.exportArn, exportTime: completed.exportTime, s3Bucket: completed.bucket, s3Prefix: completed.prefix, s3SseAlgorithm: 'AES256', manifestFilesS3Key: `${directory}manifest-files.json`, itemCount: 1, outputFormat: 'DYNAMODB_JSON' })
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> { const items: T[] = []; for await (const item of source) items.push(item); return items }

describe('DynamoDB export manifest and data source', () => {
  const s3 = new S3Client({ region: context.region, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } })
  const aws = mockClient(s3)
  const objects = new Map<string, Buffer>()
  const save = (key: string, value: unknown) => objects.set(key, Buffer.from(JSON.stringify(value)))
  beforeEach(() => {
    aws.reset(); objects.clear(); save(completed.manifestKey, summary()); save(`${directory}manifest-files.json`, file()); objects.set(dataKey, data)
    aws.on(HeadObjectCommand).callsFake((input) => {
      const body = objects.get(input.Key!); if (!body) throw new Error('NoSuchKey')
      return { ETag: `"${createHash('md5').update(body).digest('hex')}"`, ContentLength: body.length, VersionId: 'v1' }
    })
    aws.on(GetObjectCommand).callsFake((input) => {
      const body = objects.get(input.Key!); if (!body) throw new Error('NoSuchKey')
      return { ETag: `"${createHash('md5').update(body).digest('hex')}"`, ContentLength: body.length, VersionId: 'v1', Body: Readable.from([body]) }
    })
  })
  afterAll(() => { aws.restore(); s3.destroy() })
  it('includes restoration manifests and checksum-verified gzip data', async () => {
    const sources = await collect(enumerateDynamoBackupSources(s3, context, completed, { maxFiles: 100, maxObjectBytes: 10000 }))
    expect(sources.map((source) => source.format)).toEqual(['dynamodb-manifest', 'dynamodb-manifest', 'dynamodb-json-gzip'])
    const bytes = Buffer.concat(await collect(sources[2].open(new AbortController().signal)) as Buffer[])
    expect(bytes.equals(data)).toBe(true)
    expect(aws.commandCalls(GetObjectCommand).every((call) => call.args[0].input.ExpectedBucketOwner === context.accountId)).toBe(true)
  })
  it.each([
    { tableArn: `${tableArn}-other` }, { exportArn: `${completed.exportArn}-other` }, { itemCount: 0 },
    { outputFormat: 'ION' }, { exportType: 'INCREMENTAL_EXPORT' }, { manifestFilesS3Key: 'unrelated/manifest-files.json' },
  ])('refuses a summary inconsistent with the completed export (%#)', async (change) => {
    save(completed.manifestKey, { ...summary(), ...change })
    await expect(collect(enumerateDynamoBackupSources(s3, context, completed, { maxFiles: 100, maxObjectBytes: 10000 }))).rejects.toThrow('BACKUP_DYNAMODB_MANIFEST_INVALID')
  })
  it.each([
    { dataFileS3Key: 'outside/data.json.gz' }, { itemCount: 0 }, { md5Checksum: 'invalid' },
  ])('rejects manifest entries that escape scope or disagree with the total (%#)', async (change) => {
    save(`${directory}manifest-files.json`, { ...file(), ...change })
    await expect(collect(enumerateDynamoBackupSources(s3, context, completed, { maxFiles: 100, maxObjectBytes: 10000 }))).rejects.toThrow('BACKUP_DYNAMODB_MANIFEST_INVALID')
  })
  it('rejects duplicate data files', async () => {
    objects.set(`${directory}manifest-files.json`, Buffer.from(`${JSON.stringify(file())}\n${JSON.stringify(file())}\n`))
    await expect(collect(enumerateDynamoBackupSources(s3, context, completed, { maxFiles: 100, maxObjectBytes: 10000 }))).rejects.toThrow('BACKUP_DYNAMODB_MANIFEST_INVALID')
  })
  it('detects a data checksum mismatch before ending its source successfully', async () => {
    save(`${directory}manifest-files.json`, { ...file(), md5Checksum: Buffer.alloc(16).toString('base64') })
    const sources = await collect(enumerateDynamoBackupSources(s3, context, completed, { maxFiles: 100, maxObjectBytes: 10000 }))
    await expect(collect(sources[2].open(new AbortController().signal))).rejects.toThrow('BACKUP_DYNAMODB_CHECKSUM_MISMATCH')
  })
  it('enforces the per-file size limit before reading the data', async () => {
    const sources = await collect(enumerateDynamoBackupSources(s3, context, completed, { maxFiles: 100, maxObjectBytes: 1 }))
    await expect(collect(sources[2].open(new AbortController().signal))).rejects.toThrow('BACKUP_EXPORT_SIZE_LIMIT')
    expect(aws.commandCalls(GetObjectCommand).some((call) => call.args[0].input.Key === dataKey)).toBe(false)
  })
  it.each([false, true])('connects verified files to encrypted uploads, checksum corruption=%s', async (corrupt) => {
    const destination = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'dest', secretAccessKey: 'dest' } })
    const remote = mockClient(destination)
    const stored = new Map<string, Buffer>()
    const parts = new Map<string, Buffer[]>()
    const retainUntil = new Date('2099-01-01')
    remote.on(GetObjectLockConfigurationCommand).resolves({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })
    remote.on(CreateMultipartUploadCommand).callsFake((request) => { parts.set(request.Key!, []); return { UploadId: request.Key } })
    remote.on(UploadPartCommand).callsFake((request) => { parts.get(request.Key!)!.push(Buffer.from(request.Body as Uint8Array)); return { ETag: '"part"' } })
    remote.on(CompleteMultipartUploadCommand).callsFake((request) => { stored.set(request.Key!, Buffer.concat(parts.get(request.Key!)!)); return { VersionId: 'v1' } })
    remote.on(HeadObjectCommand).callsFake((request) => ({ VersionId: 'v1', ContentLength: stored.get(request.Key!)!.length, ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: retainUntil }))
    remote.on(AbortMultipartUploadCommand).resolves({})
    try {
      if (corrupt) save(`${directory}manifest-files.json`, { ...file(), md5Checksum: Buffer.alloc(16).toString('base64') })
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const operation = writeBackupExport(destination, (signal) => enumerateDynamoBackupSources(s3, context, completed, { maxFiles: 100, maxObjectBytes: 10000 }, signal), {
        runId: 'ddb-run', bucket: 'tenant-backup', prefix: 'test/', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), retainUntil,
        maxObjectBytes: 10000, maxTotalBytes: 100000, maxObjects: 100, timeoutMs: 10000,
      })
      if (corrupt) {
        await expect(operation).rejects.toThrow('BACKUP_EXPORT_FAILED')
        expect(remote.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
        expect([...stored.keys()].some((key) => key.endsWith('manifest.json'))).toBe(false)
      } else {
        const receipt = await operation
        expect(receipt.objectCount).toBe(3)
        expect(stored.has(receipt.manifest.key)).toBe(true)
        expect(remote.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(5)
      }
      expect([...stored.entries()].filter(([key]) => key.endsWith('.enc')).every(([, bytes]) => bytes.subarray(0, 8).toString() === 'BYOBKP01')).toBe(true)
    } finally { remote.restore(); destination.destroy() }
  })
})
