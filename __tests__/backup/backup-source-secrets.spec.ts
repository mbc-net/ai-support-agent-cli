import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { TEST_CA_PEM } from '../fixtures/rdp-trusted-ca-pems'
import { loadBackupExportConfiguration, loadBackupDatabaseConnection } from '../../src/backup/backup-source-secrets'

jest.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: jest.fn(() => async () => ({ accessKeyId: 'host', secretAccessKey: 'host' })) }))
const context = { accountId: '123456789012', region: 'ap-northeast-1' }
const arn = (name: string) => `arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:${name}-aBc123`
const database = { resourceArn: 'arn:aws:rds:ap-northeast-1:123456789012:db:app', name: 'app', credentialSecretArn: arn('credentials'), caSecretArn: arn('ca') }
const endpoint = { resourceArn: database.resourceArn, engine: 'postgres', host: 'app.abc.ap-northeast-1.rds.amazonaws.com', port: 5432 }
const configuration = () => ({ version: 1, databases: [database], dynamodbStaging: { bucket: 'tenant-staging', prefix: 'backup-export/' } })

describe('tenant backup source secrets', () => {
  const sts = mockClient(STSClient)
  const secrets = mockClient(SecretsManagerClient)
  beforeEach(() => {
    sts.reset(); secrets.reset()
    sts.on(GetCallerIdentityCommand).resolves({ Account: context.accountId })
    secrets.on(GetSecretValueCommand, { SecretId: arn('config') }).resolves({ SecretString: JSON.stringify(configuration()) })
    secrets.on(GetSecretValueCommand, { SecretId: arn('credentials') }).resolves({ SecretString: JSON.stringify({ username: 'backup', password: 'sensitive' }) })
    secrets.on(GetSecretValueCommand, { SecretId: arn('ca') }).resolves({ SecretString: TEST_CA_PEM })
  })
  afterAll(() => { sts.restore(); secrets.restore() })
  it('loads only references in the export configuration and uses AWSCURRENT', async () => {
    expect(await loadBackupExportConfiguration(arn('config'), context)).toEqual(configuration())
    expect(secrets.commandCalls(GetSecretValueCommand)[0].args[0].input).toEqual({ SecretId: arn('config'), VersionStage: 'AWSCURRENT' })
  })
  it('rejects account mismatch before reading any secret', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '999999999999' })
    await expect(loadBackupExportConfiguration(arn('config'), context)).rejects.toThrow('BACKUP_AWS_ACCOUNT_MISMATCH')
    expect(secrets.calls()).toHaveLength(0)
  })
  it.each([
    arn('config').replace('123456789012', '999999999999'),
    arn('config').replace('ap-northeast-1', 'us-east-1'),
    arn('config').replace('arn:aws:', 'arn:aws-cn:'),
  ])('rejects an out-of-scope configuration ARN before contacting AWS (%#)', async (secretArn) => {
    await expect(loadBackupExportConfiguration(secretArn, context)).rejects.toThrow('BACKUP_SOURCE_INVALID_CONFIGURATION')
    expect(sts.calls()).toHaveLength(0)
    expect(secrets.calls()).toHaveLength(0)
  })
  it.each([
    { ...configuration(), databases: [{ ...database, password: 'raw password' }] },
    { ...configuration(), databases: [database, database] },
    { ...configuration(), databases: [{ ...database, credentialSecretArn: arn('credentials').replace('123456789012', '999999999999') }] },
    { ...configuration(), databases: [{ ...database, resourceArn: database.resourceArn.replace('123456789012', '999999999999') }] },
    { ...configuration(), databases: [{ ...database, resourceArn: database.resourceArn.replace(':db:app', ':unexpected:db:app') }] },
    { ...configuration(), dynamodbStaging: { bucket: 'https://attacker.example', prefix: '' } },
  ])('rejects credentials, duplicate mappings and scope escapes in configuration (%#)', async (config) => {
    secrets.on(GetSecretValueCommand, { SecretId: arn('config') }).resolves({ SecretString: JSON.stringify(config) })
    await expect(loadBackupExportConfiguration(arn('config'), context)).rejects.toThrow(/^BACKUP_SOURCE_INVALID_CONFIGURATION$/)
  })
  it('combines verified RDS endpoint metadata, credential fields and the trusted CA', async () => {
    const connection = await loadBackupDatabaseConnection(database, endpoint, context)
    expect(connection).toEqual({ engine: 'postgres', host: endpoint.host, port: 5432, database: 'app', username: 'backup', password: 'sensitive', caPem: TEST_CA_PEM })
  })
  it('refuses a credential secret pointing to a different endpoint', async () => {
    secrets.on(GetSecretValueCommand, { SecretId: arn('credentials') }).resolves({ SecretString: JSON.stringify({ username: 'backup', password: 'sensitive', host: 'attacker.example' }) })
    await expect(loadBackupDatabaseConnection(database, endpoint, context)).rejects.toThrow(/^BACKUP_DATABASE_SECRET_MISMATCH$/)
  })
  it('refuses a mismatched resource before reading database credentials', async () => {
    await expect(loadBackupDatabaseConnection(database, { ...endpoint, resourceArn: `${endpoint.resourceArn}-other` }, context)).rejects.toThrow('BACKUP_SOURCE_INVALID_CONFIGURATION')
    expect(secrets.calls()).toHaveLength(0)
  })
  it('checks a resource identifier in a managed database secret', async () => {
    secrets.on(GetSecretValueCommand, { SecretId: arn('credentials') }).resolves({ SecretString: JSON.stringify({ username: 'backup', password: 'sensitive', dbInstanceIdentifier: 'other' }) })
    await expect(loadBackupDatabaseConnection(database, endpoint, context)).rejects.toThrow(/^BACKUP_DATABASE_SECRET_MISMATCH$/)
  })
  it('carries the explicit MySQL consistency choice into the dump connection', async () => {
    const mapping = { ...database, mysqlConsistency: 'innodb-no-ddl' as const }
    secrets.on(GetSecretValueCommand, { SecretId: arn('config') }).resolves({ SecretString: JSON.stringify({ version: 1, databases: [mapping] }) })
    expect((await loadBackupExportConfiguration(arn('config'), context)).databases[0]).toEqual(mapping)
    expect((await loadBackupDatabaseConnection(mapping, { ...endpoint, engine: 'mysql', port: 3306 }, context)).mysqlConsistency).toBe('innodb-no-ddl')
  })
  it('rejects MySQL without an explicit consistency choice before reading credentials', async () => {
    await expect(loadBackupDatabaseConnection(database, { ...endpoint, engine: 'mysql', port: 3306 }, context)).rejects.toThrow('BACKUP_SOURCE_INVALID_CONFIGURATION')
    expect(secrets.calls()).toHaveLength(0)
  })
  it('does not return SDK errors or credential JSON on failure', async () => {
    secrets.on(GetSecretValueCommand).rejects(new Error('sensitive credentials'))
    await expect(loadBackupExportConfiguration(arn('config'), context)).rejects.toThrow(/^BACKUP_SOURCE_SECRET_UNAVAILABLE$/)
  })
})
