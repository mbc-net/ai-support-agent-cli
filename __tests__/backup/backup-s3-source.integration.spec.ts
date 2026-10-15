import { S3Client } from '@aws-sdk/client-s3'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { listBackupS3Objects, streamBackupS3Object } from '../../src/backup/backup-s3-source'

describe('S3 source over the SDK HTTP protocol', () => {
  it('preserves encoded keys and pins version, ETag and bucket owner on the wire', async () => {
    const key = 'data/%01 日本\u0001'
    const requests: { method: string; key: string; owner: string | undefined; etag: string | undefined; version: string | null; encoding: string | null }[] = []
    const server = createServer((req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      requests.push({ method: req.method!, key: decodeURIComponent(url.pathname), owner: req.headers['x-amz-expected-bucket-owner'] as string | undefined, etag: req.headers['if-match'], version: url.searchParams.get('versionId'), encoding: url.searchParams.get('encoding-type') })
      if (url.searchParams.get('list-type') === '2') {
        res.setHeader('Content-Type', 'application/xml')
        res.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><EncodingType>url</EncodingType><IsTruncated>false</IsTruncated><Contents><Key>${encodeURIComponent(key)}</Key><ETag>&quot;etag&quot;</ETag><Size>3</Size></Contents></ListBucketResult>`)
      } else {
        res.setHeader('Content-Length', '3')
        res.setHeader('ETag', '"etag"')
        res.setHeader('x-amz-version-id', 'source-version')
        res.end(req.method === 'HEAD' ? undefined : 'abc')
      }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const client = new S3Client({
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1,
    })
    try {
      const payload: Buffer[] = []
      for await (const item of listBackupS3Objects(client, { bucket: 'tenant-source', accountId: '123456789012', prefix: 'data/', maxObjects: 5, maxObjectBytes: 1000 })) {
        expect(item.key).toBe(key)
        for await (const bytes of streamBackupS3Object(client, item)) payload.push(bytes)
      }
      expect(Buffer.concat(payload).toString()).toBe('abc')
      expect(requests).toHaveLength(3)
      expect(requests.every((r) => r.owner === '123456789012')).toBe(true)
      expect(requests[0].encoding).toBe('url')
      expect(requests[1]).toMatchObject({ method: 'HEAD', key: `/tenant-source/${key}`, etag: '"etag"' })
      expect(requests[2]).toMatchObject({ method: 'GET', key: `/tenant-source/${key}`, etag: '"etag"', version: 'source-version' })
    } finally {
      client.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
