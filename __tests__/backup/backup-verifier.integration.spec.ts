import { S3Client } from '@aws-sdk/client-s3'
import { generateKeyPairSync } from 'crypto'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { writeBackupExport } from '../../src/backup/backup-export-writer'
import { verifyBackupExport } from '../../src/backup/backup-verifier'

/** Real SDK serialization and streaming over a local fixture, not Wasabi retention enforcement. */
describe('export and verify over S3 HTTP', () => {
  it('verifies every version and rejects subsequent byte corruption without decrypting', async () => {
    const pending = new Map<string, { parts: Buffer[]; until: string }>()
    const stored = new Map<string, { bytes: Buffer; version: string; until: string }>()
    const reads: { method: string; key: string; version: string | null }[] = []
    let sequence = 0
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://localhost')
      const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'))
      res.setHeader('Content-Type', 'application/xml')
      if (req.method === 'GET' && url.searchParams.has('object-lock')) {
        res.end('<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>Enabled</ObjectLockEnabled></ObjectLockConfiguration>')
      } else if (req.method === 'POST' && url.searchParams.has('uploads')) {
        pending.set(key, { parts: [], until: req.headers['x-amz-object-lock-retain-until-date'] as string })
        res.end('<InitiateMultipartUploadResult><UploadId>wire</UploadId></InitiateMultipartUploadResult>')
      } else if (req.method === 'PUT' && url.searchParams.get('uploadId') === 'wire') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        pending.get(key)!.parts[Number(url.searchParams.get('partNumber')) - 1] = Buffer.concat(chunks)
        res.setHeader('ETag', '"part"'); res.end()
      } else if (req.method === 'POST' && url.searchParams.get('uploadId') === 'wire') {
        for await (const _chunk of req) { /* consume completion XML */ }
        const item = pending.get(key)!
        const version = `version-${++sequence}`
        stored.set(key, { bytes: Buffer.concat(item.parts), version, until: item.until })
        pending.delete(key)
        res.setHeader('x-amz-version-id', version)
        res.end('<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>')
      } else if (req.method === 'HEAD' || req.method === 'GET') {
        const item = stored.get(key)
        reads.push({ method: req.method, key, version: url.searchParams.get('versionId') })
        if (!item || url.searchParams.get('versionId') !== item.version) {
          res.statusCode = 404; res.end('<Error><Code>NoSuchVersion</Code></Error>'); return
        }
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', item.bytes.length)
        res.setHeader('x-amz-version-id', item.version)
        res.setHeader('x-amz-object-lock-mode', 'COMPLIANCE')
        res.setHeader('x-amz-object-lock-retain-until-date', item.until)
        if (req.method === 'HEAD') res.end()
        else res.end(item.bytes)
      } else { res.statusCode = 400; res.end('<Error><Code>UnexpectedRequest</Code></Error>') }
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const client = new S3Client({ endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, region: 'us-east-1', forcePathStyle: true,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' }, maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })
    try {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      const source = Buffer.alloc(9 * 1024 * 1024, 0x61)
      async function* enumerate() {
        yield { resourceArn: 'arn:aws:s3:::source-bucket', name: 'source-file', format: 's3-object' as const,
          open: async function* () { for (let offset = 0; offset < source.length; offset += 65536) yield source.subarray(offset, offset + 65536) } }
      }
      const receipt = await writeBackupExport(client, enumerate, { runId: 'verify-wire', bucket: 'backup-bucket', prefix: 'daily', publicKeyPem,
        retainUntil: new Date('2099-01-01'), maxObjectBytes: 10 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024, maxObjects: 10, timeoutMs: 10000 })
      reads.length = 0
      const options = { maxObjects: 10, maxTotalCiphertextBytes: 11 * 1024 * 1024, minimumRetainUntil: new Date('2098-01-01'), timeoutMs: 10000 }
      const result = await verifyBackupExport(client, receipt, options)
      expect(result).toMatchObject({ objectCount: 1, checkedObjects: 3, ciphertextBytes: [...stored.values()].reduce((n, item) => n + item.bytes.length, 0) })
      expect(reads).toHaveLength(6)
      expect(reads.filter(item => item.method === 'GET')).toHaveLength(3)
      for (const read of reads) expect(read.version).toBe(stored.get(read.key)!.version)
      expect(JSON.stringify(result)).not.toContain('source-file')
      const dataKey = [...stored.keys()].find(key => key.endsWith('/000000.enc'))!
      stored.get(dataKey)!.bytes[0] ^= 1
      await expect(verifyBackupExport(client, receipt, options)).rejects.toThrow('BACKUP_VERIFY_DIGEST_MISMATCH')
      stored.delete(dataKey)
      await expect(verifyBackupExport(client, receipt, options)).rejects.toThrow('BACKUP_VERIFY_READ_FAILED')
    } finally {
      client.destroy(); server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
