import { S3Client } from '@aws-sdk/client-s3'
import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt } from 'crypto'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { encryptBackupStream } from '../../src/backup/backup-envelope'
import { uploadLockedBackup } from '../../src/backup/backup-upload'

/** Local S3 protocol fixture: validates wire headers and bytes, not a real storage retention guarantee. */
describe('encrypted backup over S3 HTTP protocol', () => {
  it('sends recoverable ciphertext with retention headers and verifies the stored version', async () => {
    const parts: Buffer[] = []
    const md5Valid: boolean[] = []
    let lockMode: string | undefined
    let retention: string | undefined
    let versionQueried: string | null = null
    let stored = Buffer.alloc(0)
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      res.setHeader('Content-Type', 'application/xml')
      if (req.method === 'GET' && url.searchParams.has('object-lock')) {
        res.end('<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>')
      } else if (req.method === 'POST' && url.searchParams.has('uploads')) {
        lockMode = req.headers['x-amz-object-lock-mode'] as string
        retention = req.headers['x-amz-object-lock-retain-until-date'] as string
        res.end('<InitiateMultipartUploadResult><UploadId>wire-upload</UploadId></InitiateMultipartUploadResult>')
      } else if (req.method === 'PUT' && url.searchParams.get('uploadId') === 'wire-upload') {
        parts[Number(url.searchParams.get('partNumber')) - 1] = body
        md5Valid.push(req.headers['content-md5'] === createHash('md5').update(body).digest('base64'))
        res.setHeader('ETag', '"part-etag"')
        res.end()
      } else if (req.method === 'POST' && url.searchParams.get('uploadId') === 'wire-upload') {
        stored = Buffer.concat(parts)
        res.setHeader('x-amz-version-id', 'wire-version')
        res.end('<CompleteMultipartUploadResult><ETag>"final-etag"</ETag></CompleteMultipartUploadResult>')
      } else if (req.method === 'HEAD') {
        versionQueried = url.searchParams.get('versionId')
        res.setHeader('Content-Length', stored.length)
        res.setHeader('x-amz-version-id', 'wire-version')
        res.setHeader('x-amz-object-lock-mode', lockMode!)
        res.setHeader('x-amz-object-lock-retain-until-date', retention!)
        res.end()
      } else { res.statusCode = 400; res.end('<Error><Code>UnexpectedRequest</Code></Error>') }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const client = new S3Client({
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: 'us-east-1',
      forcePathStyle: true, credentials: { accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' },
      requestChecksumCalculation: 'WHEN_REQUIRED', maxAttempts: 1,
    })
    try {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      const original = Buffer.from('database export with sensitive data')
      async function* input() { yield original }
      const until = new Date('2099-01-01T00:00:00Z')
      const result = await uploadLockedBackup(client, encryptBackupStream(input(), publicPem, 1024), {
        bucket: 'tenant-backup', key: 'run/data.enc', maxBytes: 4096, retainUntil: until,
      })
      expect(lockMode).toBe('COMPLIANCE')
      expect(new Date(retention!).getTime()).toBe(until.getTime())
      expect(md5Valid).toEqual([true])
      expect(versionQueried).toBe('wire-version')
      expect(result.sha256).toBe(createHash('sha256').update(stored).digest('hex'))
      expect(stored.includes(original)).toBe(false)
      const end = 12 + stored.readUInt32BE(8)
      const header = JSON.parse(stored.subarray(12, end).toString())
      const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(header.wrappedKey, 'base64'))
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
      decipher.setAAD(stored.subarray(0, end))
      decipher.setAuthTag(stored.subarray(-16))
      expect(Buffer.concat([decipher.update(stored.subarray(end, -16)), decipher.final()]).equals(original)).toBe(true)
    } finally {
      client.destroy()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
