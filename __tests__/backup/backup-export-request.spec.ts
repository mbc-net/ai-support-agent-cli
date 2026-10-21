import { generateKeyPairSync } from 'crypto'
import { parseBackupExportRequest } from '../../src/backup/backup-export-request'

const publicKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
const secret = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:backup-test'
const payload = () => ({
  runId: 'command-1', awsAccountId: '123456789012', region: 'ap-northeast-1',
  targets: [{ type: 's3', selector: { mode: 'arn', arns: ['arn:aws:s3:::source-bucket'] } }],
  exportConfigurationSecretArn: secret, exportTime: '2026-01-01T00:00:00.000Z', publicKeyPem,
  destination: { provider: 'wasabi', endpoint: 'https://s3.ap-northeast-1.wasabisys.com', region: 'ap-northeast-1', writeCredentialSecretArn: secret, bucket: 'backup-bucket', prefix: 'daily' },
  retentionDays: 30, limits: { maxObjects: 100, maxObjectBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 * 10, timeoutMs: 60000 },
})
it('accepts a bounded export and copies nested values', () => {
  const input = payload(); const result = parseBackupExportRequest(input)
  input.targets[0].selector.arns[0] = 'changed'; input.limits.maxObjects = 1
  expect(result.targets[0].selector).toEqual({ mode: 'arn', arns: ['arn:aws:s3:::source-bucket'] })
  expect(result.limits.maxObjects).toBe(100)
  expect(result.exportTime.toISOString()).toBe('2026-01-01T00:00:00.000Z')
})
it.each([
  (p: any) => { p.password = 'secret' },
  (p: any) => { p.destination.accessKeyId = 'secret' },
  (p: any) => { p.destination.endpoint = 'http://127.0.0.1' },
  (p: any) => { p.destination.provider = 'cloudflare_r2' },
  (p: any) => { p.destination.writeCredentialSecretArn = secret.replace('123456789012', '999999999999') },
  (p: any) => { p.exportConfigurationSecretArn = secret.replace('123456789012', '999999999999') },
  (p: any) => { p.targets[0].selector.arns = ['arn:aws:rds:ap-northeast-1:999999999999:db:source'] },
  (p: any) => { p.limits.maxObjects = 10001 },
  (p: any) => { p.limits.maxObjectBytes = 2 ** 36 },
  (p: any) => { p.limits.maxTotalBytes = 2 ** 40 + 1 },
  (p: any) => { p.limits.timeoutMs = 21600001 },
  (p: any) => { p.retentionDays = 0 },
  (p: any) => { p.publicKeyPem = 'invalid' },
  (p: any) => { p.exportTime = '2099-01-01T00:00:00.000Z' },
  (p: any) => { p.exportTime = '2026-02-30T00:00:00.000Z' },
  (p: any) => { p.runId = '../escape' },
])('rejects invalid or secret-bearing input before execution (%#)', mutate => {
  const input = payload(); mutate(input)
  expect(() => parseBackupExportRequest(input)).toThrow(/^BACKUP_INVALID_REQUEST$/)
})
