import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Readable } from 'stream'
import { listBackupS3Objects, streamBackupS3Object } from '../../src/backup/backup-s3-source'

const target = { bucket: 'tenant-source', accountId: '123456789012', prefix: 'data/', maxObjects: 100, maxObjectBytes: 10000 }
const object = { bucket: target.bucket, accountId: target.accountId, key: 'data/file', etag: '"etag"', bytes: 3 }
async function collect<T>(input: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of input) result.push(item); return result }

describe('S3 backup source', () => {
  const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  const aws = mockClient(s3)
  beforeEach(() => aws.reset())
  afterAll(() => { aws.restore(); s3.destroy() })
  it('lists every page with the expected owner and retains exact keys', async () => {
    aws.on(ListObjectsV2Command).resolvesOnce({ Contents: [{ Key: 'data/a b', ETag: '"a"', Size: 0 }], IsTruncated: true, NextContinuationToken: 'next' }).resolves({ Contents: [{ Key: 'data/c', ETag: '"c"', Size: 3 }], IsTruncated: false })
    expect(await collect(listBackupS3Objects(s3, target))).toEqual([
      { bucket: target.bucket, accountId: target.accountId, key: 'data/a b', etag: '"a"', bytes: 0 },
      { ...object, key: 'data/c', etag: '"c"' },
    ])
    expect(aws.commandCalls(ListObjectsV2Command)[1].args[0].input).toMatchObject({ Bucket: target.bucket, ExpectedBucketOwner: target.accountId, Prefix: target.prefix, ContinuationToken: 'next' })
  })
  it('fails on a repeated continuation token', async () => {
    aws.on(ListObjectsV2Command).resolves({ IsTruncated: true, NextContinuationToken: 'loop' })
    await expect(collect(listBackupS3Objects(s3, target))).rejects.toThrow('BACKUP_S3_PAGINATION_FAILED')
  })
  it('decodes URL-encoded keys exactly once, including literal percent sequences', async () => {
    aws.on(ListObjectsV2Command).resolves({ EncodingType: 'url', Contents: [{ Key: 'data%2F%2501%20%E6%97%A5%E6%9C%AC', ETag: '"a"', Size: 1 }], IsTruncated: false })
    expect((await collect(listBackupS3Objects(s3, target)))[0].key).toBe('data/%01 日本')
    expect(aws.commandCalls(ListObjectsV2Command)[0].args[0].input.EncodingType).toBe('url')
  })
  it.each([
    { Contents: [{ Key: 'other/file', ETag: '"a"', Size: 1 }] },
    { Contents: [{ Key: 'data/file', Size: 1 }] },
    { Contents: [{ Key: 'data/file', ETag: '"a"', Size: 10001 }] },
  ])('rejects malformed or oversized listing entries (%#)', async (response) => {
    aws.on(ListObjectsV2Command).resolves(response)
    await expect(collect(listBackupS3Objects(s3, target))).rejects.toThrow(/^BACKUP_S3_/)
  })
  it('does not silently truncate at the configured object count', async () => {
    aws.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'data/a', ETag: '"a"', Size: 1 }, { Key: 'data/b', ETag: '"b"', Size: 1 }] })
    await expect(collect(listBackupS3Objects(s3, { ...target, maxObjects: 1 }))).rejects.toThrow('BACKUP_S3_OBJECT_LIMIT')
  })
  it('pins the current version before reading and returns the actual bytes', async () => {
    aws.on(HeadObjectCommand).resolves({ ETag: object.etag, ContentLength: 3, VersionId: 'v1' })
    aws.on(GetObjectCommand).resolves({ ETag: object.etag, ContentLength: 3, VersionId: 'v1', Body: Readable.from([Buffer.from('abc')]) as never })
    expect(Buffer.concat(await collect(streamBackupS3Object(s3, object))).toString()).toBe('abc')
    expect(aws.commandCalls(GetObjectCommand)[0].args[0].input).toEqual({ Bucket: target.bucket, ExpectedBucketOwner: target.accountId, Key: object.key, IfMatch: object.etag, VersionId: 'v1' })
  })
  it('rejects an object changed since listing without reading it', async () => {
    aws.on(HeadObjectCommand).resolves({ ETag: '"new"', ContentLength: 3 })
    await expect(collect(streamBackupS3Object(s3, object))).rejects.toThrow('BACKUP_S3_SOURCE_CHANGED')
    expect(aws.commandCalls(GetObjectCommand)).toHaveLength(0)
  })
  it.each([2, 4])('rejects truncated or oversized response bodies (%s bytes)', async (bytes) => {
    aws.on(HeadObjectCommand).resolves({ ETag: object.etag, ContentLength: 3 })
    const body = Readable.from([Buffer.alloc(bytes)])
    aws.on(GetObjectCommand).resolves({ ETag: object.etag, ContentLength: 3, Body: body as never })
    await expect(collect(streamBackupS3Object(s3, object))).rejects.toThrow('BACKUP_S3_SOURCE_CHANGED')
    expect(body.destroyed).toBe(true)
  })
  it('destroys a stalled body when cancelled', async () => {
    const controller = new AbortController()
    const body = new Readable({ read() { setImmediate(() => controller.abort()) } })
    aws.on(HeadObjectCommand).resolves({ ETag: object.etag, ContentLength: 3 })
    aws.on(GetObjectCommand).resolves({ ETag: object.etag, ContentLength: 3, Body: body as never })
    await expect(collect(streamBackupS3Object(s3, object, controller.signal))).rejects.toThrow('BACKUP_EXPORT_ABORTED')
    expect(body.destroyed).toBe(true)
  })
  it('never returns provider error details', async () => {
    aws.on(ListObjectsV2Command).rejects(new Error('secret credential process stderr'))
    await expect(collect(listBackupS3Objects(s3, target))).rejects.toThrow(/^BACKUP_S3_READ_FAILED$/)
  })
})
