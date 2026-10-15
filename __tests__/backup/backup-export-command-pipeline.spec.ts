import { S3Client, GetBucketLocationCommand, HeadBucketCommand, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, GetObjectLockConfigurationCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { mockClient } from 'aws-sdk-client-mock'
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'crypto'
import { Readable } from 'stream'
import { parseBackupVerificationManifest } from '../../src/backup/backup-verification-manifest'
import { executeBackupExport } from '../../src/backup/backup-export-command'
import { executeBackupVerify } from '../../src/backup/backup-verify-command'

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const configArn = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:config-test'
const storageArn = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:storage-test'
const payload = () => ({
  runId: 'command-pipeline', awsAccountId: '123456789012', region: 'ap-northeast-1',
  targets: [{ type: 's3', selector: { mode: 'arn', arns: ['arn:aws:s3:::source-bucket'] } }],
  exportConfigurationSecretArn: configArn, exportTime: '2026-01-01T00:00:00.000Z',
  publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  destination: { provider: 'wasabi', endpoint: 'https://s3.ap-northeast-1.wasabisys.com', region: 'ap-northeast-1', writeCredentialSecretArn: storageArn, bucket: 'backup-bucket', prefix: 'daily' },
  retentionDays: 30, limits: { maxObjects: 100, maxObjectBytes: 10000, maxTotalBytes: 100000, timeoutMs: 10000 },
})
function decrypt(bytes: Buffer): string {
  const end = 12 + bytes.readUInt32BE(8); const header = JSON.parse(bytes.subarray(12, end).toString())
  const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(header.wrappedKey, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  decipher.setAAD(bytes.subarray(0, end)); decipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([decipher.update(bytes.subarray(end, -16)), decipher.final()]).toString()
}
describe('backup_export command with real orchestration, source, crypto and multipart code', () => {
  const s3 = mockClient(S3Client); const sts = mockClient(STSClient); const secrets = mockClient(SecretsManagerClient)
  const pending = new Map<string, Buffer[]>(); const stored = new Map<string, Buffer>(); const retention = new Map<string, Date>()
  const original = 'private source content'
  beforeEach(() => {
    s3.reset(); sts.reset(); secrets.reset(); pending.clear(); stored.clear(); retention.clear()
    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' })
    secrets.on(GetSecretValueCommand, { SecretId: configArn }).resolves({ ARN: configArn, SecretString: JSON.stringify({ version: 1, databases: [] }) })
    secrets.on(GetSecretValueCommand, { SecretId: storageArn }).resolves({ ARN: storageArn, SecretString: JSON.stringify({ accessKeyId: 'fixture-key', secretAccessKey: 'fixture-secret' }) })
    s3.on(HeadBucketCommand).resolves({})
    s3.on(GetBucketLocationCommand).resolves({ LocationConstraint: 'ap-northeast-1' })
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'resource-inventory.json', Size: Buffer.byteLength(original), ETag: '"source-etag"' }] })
    s3.on(GetObjectCommand).callsFake(() => ({ Body: Readable.from([Buffer.from(original)]), ContentLength: Buffer.byteLength(original), ETag: '"source-etag"', VersionId: 'source-version' }))
    s3.on(GetObjectLockConfigurationCommand).resolves({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } })
    s3.on(CreateMultipartUploadCommand).callsFake(input => { pending.set(input.Key, []); retention.set(input.Key, input.ObjectLockRetainUntilDate); return { UploadId: input.Key } })
    s3.on(UploadPartCommand).callsFake(input => { pending.get(input.Key)!.push(Buffer.from(input.Body)); return { ETag: '"part"' } })
    s3.on(CompleteMultipartUploadCommand).callsFake(input => { stored.set(input.Key, Buffer.concat(pending.get(input.Key)!)); return { VersionId: 'stored-version' } })
    s3.on(HeadObjectCommand).callsFake(input => input.Bucket === 'source-bucket'
      ? { ContentLength: Buffer.byteLength(original), ETag: '"source-etag"', VersionId: 'source-version' }
      : { ContentLength: stored.get(input.Key)!.length, VersionId: 'stored-version', ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: retention.get(input.Key) })
    s3.on(AbortMultipartUploadCommand).resolves({})
  })
  afterAll(() => { s3.restore(); sts.restore(); secrets.restore() })
  it('returns a committed receipt whose encrypted catalog and data are usable', async () => {
    const result = await executeBackupExport(payload(), true, 'command-pipeline')
    expect(result.success).toBe(true)
    const data = (result as any).data
    expect(data).toMatchObject({ version: 1, nativeOnlyTypes: [], receipt: { objectCount: 2 } })
    const manifest = JSON.parse(stored.get(data.receipt.manifest.key)!.toString())
    expect(parseBackupVerificationManifest(manifest, data.receipt, { maxObjects: 100, maxTotalCiphertextBytes: 100000, minimumRetainUntil: new Date() }, new Date())).toEqual(manifest)
    const catalog = JSON.parse(decrypt(stored.get(manifest.catalog.key)!))
    expect(catalog.objects.map((item: any) => item.format)).toEqual(['resource-inventory', 's3-object'])
    expect(decrypt(stored.get(manifest.objects[1].key)!)).toBe(original)
    expect(JSON.parse(decrypt(stored.get(manifest.objects[0].key)!))).toEqual({ version: 1, resources: [{ type: 's3', arn: 'arn:aws:s3:::source-bucket' }] })
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|private source|source-bucket/)
    expect(sts.commandCalls(GetCallerIdentityCommand)).toHaveLength(3)
  })
  it('verifies an exported receipt through the real command and refuses ciphertext corruption', async () => {
    const exported = await executeBackupExport(payload(), true, 'command-pipeline')
    expect(exported.success).toBe(true)
    const { runId, attemptId, objectCount, manifest } = (exported as any).data.receipt
    const request = {
      verificationId: 'verification-pipeline', awsAccountId: payload().awsAccountId, region: payload().region,
      destination: payload().destination, reference: { runId, attemptId, objectCount, manifest },
      limits: { maxObjects: 100, maxTotalCiphertextBytes: 100000, minimumRetainUntil: new Date().toISOString(), timeoutMs: 10000 },
    }
    s3.on(GetObjectCommand).callsFake(input => ({ Body: Readable.from([stored.get(input.Key)!]),
      ContentLength: stored.get(input.Key)!.length, VersionId: 'stored-version', ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: retention.get(input.Key) }))
    s3.resetHistory(); secrets.resetHistory()
    const verified = await executeBackupVerify(request, true, 'verification-pipeline')
    expect(verified).toMatchObject({ success: true, data: { verificationId: 'verification-pipeline', verification: { runId, attemptId, objectCount: 2, checkedObjects: 4 } } })
    expect(s3.calls()).toHaveLength(8)
    for (const call of s3.calls()) {
      expect([GetObjectCommand, HeadObjectCommand]).toContain(call.args[0].constructor)
      expect(call.args[0].input).toMatchObject({ Bucket: 'backup-bucket', VersionId: 'stored-version' })
    }
    expect(secrets.commandCalls(GetSecretValueCommand)).toHaveLength(1)
    expect(secrets.commandCalls(GetSecretValueCommand)[0].args[0].input).toEqual({ SecretId: storageArn, VersionStage: 'AWSCURRENT' })
    expect(JSON.stringify(verified)).not.toMatch(/fixture-secret|private source|source-bucket/)
    const dataKey = [...stored.keys()].find(key => key.endsWith('/000001.enc'))!
    stored.get(dataKey)![0] ^= 1
    expect(await executeBackupVerify(request, true, 'verification-pipeline')).toEqual({ success: false, error: 'BACKUP_VERIFY_DIGEST_MISMATCH' })
  })
  it('rejects changed source data without publishing a completion manifest', async () => {
    s3.on(GetObjectCommand).callsFake(() => ({ Body: Readable.from([Buffer.from(original)]), ContentLength: Buffer.byteLength(original), ETag: '"changed"', VersionId: 'source-version' }))
    expect(await executeBackupExport(payload(), true, 'command-pipeline')).toEqual({ success: false, error: 'BACKUP_EXPORT_FAILED' })
    expect([...stored.keys()].some(key => key.endsWith('manifest.json'))).toBe(false)
    expect(s3.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1)
  })
})
