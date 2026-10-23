import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { createBackupStorageClient } from '../../src/backup/backup-storage-client'

jest.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: jest.fn(() => async () => ({ accessKeyId: 'host', secretAccessKey: 'host-secret' })) }))
const expected = { accountId: '123456789012', region: 'ap-northeast-1' }
const destination = () => ({ provider: 'wasabi', endpoint: 'https://s3.ap-northeast-1.wasabisys.com', region: 'ap-northeast-1', writeCredentialSecretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:backup-write-aBc123' })

describe('tenant backup storage credentials', () => {
  const sts = mockClient(STSClient)
  const secrets = mockClient(SecretsManagerClient)
  beforeEach(() => {
    sts.reset(); secrets.reset()
    sts.on(GetCallerIdentityCommand).resolves({ Account: expected.accountId })
    secrets.on(GetSecretValueCommand).resolves({ SecretString: JSON.stringify({ accessKeyId: 'wasabi-key', secretAccessKey: 'wasabi-secret' }) })
  })
  afterAll(() => { sts.restore(); secrets.restore() })
  it('reads only the scoped secret and gives storage its own static credentials', async () => {
    const client = await createBackupStorageClient(destination(), expected)
    try {
      expect(secrets.commandCalls(GetSecretValueCommand)[0].args[0].input).toEqual({ SecretId: destination().writeCredentialSecretArn, VersionStage: 'AWSCURRENT' })
      await expect(client.config.credentials()).resolves.toMatchObject({ accessKeyId: 'wasabi-key', secretAccessKey: 'wasabi-secret' })
      expect(client.config.forcePathStyle).toBe(true)
      expect(client.config.followRegionRedirects).toBe(false)
      await expect(client.config.requestChecksumCalculation()).resolves.toBe('WHEN_REQUIRED')
    } finally { client.destroy() }
  })
  it('checks STS before reading secrets', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '999999999999' })
    await expect(createBackupStorageClient(destination(), expected)).rejects.toThrow('BACKUP_AWS_ACCOUNT_MISMATCH')
    expect(secrets.calls()).toHaveLength(0)
  })
  it.each([
    { provider: 'cloudflare_r2' }, { provider: 'other' },
    { endpoint: 'http://s3.ap-northeast-1.wasabisys.com' },
    { endpoint: 'https://s3.ap-northeast-1.wasabisys.com.attacker.example' },
    { endpoint: 'https://user:password@s3.ap-northeast-1.wasabisys.com' },
    { endpoint: 'https://s3.ap-northeast-1.wasabisys.com/path' },
    { writeCredentialSecretArn: 'arn:aws:secretsmanager:ap-northeast-1:999999999999:secret:other' },
    { writeCredentialSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:other' },
  ])('rejects unsupported or out-of-scope storage before AWS calls (%#)', async (change) => {
    await expect(createBackupStorageClient({ ...destination(), ...change }, expected)).rejects.toThrow(/^BACKUP_STORAGE_/)
    expect(sts.calls()).toHaveLength(0); expect(secrets.calls()).toHaveLength(0)
  })
  it.each(['not json', '{}', '{"accessKeyId":"x","secretAccessKey":"y","privateKey":"sensitive"}'])('rejects invalid secret shape without disclosing it (%#)', async (SecretString) => {
    secrets.on(GetSecretValueCommand).resolves({ SecretString })
    await expect(createBackupStorageClient(destination(), expected)).rejects.toThrow(/^BACKUP_STORAGE_CREDENTIALS_UNAVAILABLE$/)
  })
  it('supports the approved B2 endpoint family', async () => {
    const client = await createBackupStorageClient({ ...destination(), provider: 'backblaze_b2', endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004' }, expected)
    client.destroy()
    expect(secrets.calls()).toHaveLength(1)
  })
  it('does not expose provider error details', async () => {
    secrets.on(GetSecretValueCommand).rejects(new Error('credential secret material'))
    await expect(createBackupStorageClient(destination(), expected)).rejects.toThrow(/^BACKUP_STORAGE_CREDENTIALS_UNAVAILABLE$/)
  })
})
