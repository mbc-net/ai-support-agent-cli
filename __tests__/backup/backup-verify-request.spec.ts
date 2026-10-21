import { parseBackupVerifyRequest } from '../../src/backup/backup-verify-request'

const payload = () => ({
  verificationId: 'verify-1', awsAccountId: '123456789012', region: 'ap-northeast-1',
  destination: { provider: 'wasabi', endpoint: 'https://s3.ap-northeast-1.wasabisys.com', region: 'ap-northeast-1', writeCredentialSecretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:backup-test', bucket: 'backup-bucket', prefix: 'daily' },
  reference: { runId: 'export-1', attemptId: '12345678-1234-1234-1234-123456789012', objectCount: 1,
    manifest: { bucket: 'backup-bucket', key: 'daily/export-1/12345678-1234-1234-1234-123456789012/manifest.json', versionId: 'v1', bytes: 100, sha256: 'a'.repeat(64), retainUntil: '2099-01-01T00:00:00.000Z' } },
  limits: { maxObjects: 100, maxTotalCiphertextBytes: 10000, minimumRetainUntil: '2098-01-01T00:00:00.000Z', timeoutMs: 60000 },
})

it('accepts a scoped receipt and snapshots nested fields', () => {
  const input = payload(); const result = parseBackupVerifyRequest(input)
  input.reference.manifest.versionId = 'changed'; input.destination.prefix = 'changed'; input.limits.timeoutMs = 1
  expect(result.reference.manifest.versionId).toBe('v1')
  expect(result.destination.prefix).toBe('daily')
  expect(result.limits.timeoutMs).toBe(60000)
  expect(result.limits.minimumRetainUntil.toISOString()).toBe('2098-01-01T00:00:00.000Z')
})
it.each(['', 'daily/'])('uses the writer prefix convention (%s)', prefix => {
  const input = payload(); input.destination.prefix = prefix
  input.reference.manifest.key = `${prefix}export-1/${input.reference.attemptId}/manifest.json`
  expect(parseBackupVerifyRequest(input).reference).toEqual(input.reference)
})
it.each([
  (p: any) => { p.privateKey = 'secret' },
  (p: any) => { p.verificationId = '../escape' },
  (p: any) => { p.destination.accessKeyId = 'secret' },
  (p: any) => { p.destination.endpoint = 'https://localhost' },
  (p: any) => { p.awsAccountId = '999999999999' },
  (p: any) => { p.reference.extra = true },
  (p: any) => { p.reference.manifest.bucket = 'other-bucket' },
  (p: any) => { p.reference.manifest.key = p.reference.manifest.key.replace('daily/', 'other/') },
  (p: any) => { p.reference.manifest.versionId = 'null' },
  (p: any) => { p.reference.manifest.sha256 = 'invalid' },
  (p: any) => { p.reference.manifest.retainUntil = '2000-01-01T00:00:00.000Z' },
  (p: any) => { p.limits.minimumRetainUntil = '2098-02-30T00:00:00.000Z' },
  (p: any) => { p.limits.timeoutMs = 21600001 },
  (p: any) => { p.limits.timeoutMs = 0 },
  (p: any) => { p.limits.maxObjects = 10001 },
  (p: any) => { p.limits.maxTotalCiphertextBytes = 2 ** 41 + 1 },
  (p: any) => { p.limits.maxTotalCiphertextBytes = 99 },
  (p: any) => { p.limits.extra = true },
])('rejects unsafe or impossible verification requests (%#)', mutate => {
  const input = payload(); mutate(input)
  expect(() => parseBackupVerifyRequest(input)).toThrow(/^BACKUP_INVALID_REQUEST$/)
})
