import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { X509Certificate } from 'crypto'
import type { BackupDatabaseConnection } from './backup-database-dump'

export interface BackupTenantContext { accountId: string; region: string }
export interface BackupDatabaseMapping {
  resourceArn: string
  name: string
  credentialSecretArn: string
  caSecretArn: string
  mysqlConsistency?: BackupDatabaseConnection['mysqlConsistency']
}
export interface BackupExportConfiguration {
  version: 1
  databases: BackupDatabaseMapping[]
  dynamodbStaging?: { bucket: string; prefix: string }
}
/** Values obtained from the scoped RDS Describe API, never directly from a command payload. */
export interface BackupDatabaseEndpoint {
  resourceArn: string
  engine: string
  host: string
  port: number
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function keys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)) }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) }
function partition(context: BackupTenantContext): string {
  if (!/^\d{12}$/.test(context.accountId) || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(context.region)) throw new Error('BACKUP_SOURCE_INVALID_CONFIGURATION')
  return context.region.startsWith('cn-') ? 'aws-cn' : context.region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws'
}
export function assertBackupSecretScope(arn: string, context: BackupTenantContext): void {
  const expected = partition(context)
  const match = typeof arn === 'string' && arn.length <= 2048 && arn.match(/^arn:(aws|aws-cn|aws-us-gov):secretsmanager:([a-z0-9-]+):(\d{12}):secret:([A-Za-z0-9/_+=.@-]+)$/)
  if (!match || match[1] !== expected || match[2] !== context.region || match[3] !== context.accountId) throw new Error('BACKUP_SOURCE_INVALID_CONFIGURATION')
}
function assertMapping(value: unknown, context: BackupTenantContext): asserts value is BackupDatabaseMapping {
  const expected = partition(context)
  const prefix = `arn:${expected}:rds:${context.region}:${context.accountId}:`
  if (!record(value) || !keys(value, ['resourceArn', 'name', 'credentialSecretArn', 'caSecretArn', 'mysqlConsistency']) ||
    !text(value.resourceArn, 2048) || !value.resourceArn.startsWith(prefix) ||
    !/^(?:db|cluster):[a-zA-Z][a-zA-Z0-9-]{0,62}$/.test(value.resourceArn.slice(prefix.length)) ||
    !text(value.name, 128) || /[=*]|:\/\//.test(value.name) || typeof value.credentialSecretArn !== 'string' || typeof value.caSecretArn !== 'string' ||
    (value.mysqlConsistency !== undefined && value.mysqlConsistency !== 'innodb-no-ddl' && value.mysqlConsistency !== 'global-read-lock')) throw new Error('BACKUP_SOURCE_INVALID_CONFIGURATION')
  assertBackupSecretScope(value.credentialSecretArn, context)
  assertBackupSecretScope(value.caSecretArn, context)
}

/** Secret values remain local to the agent. No logging or CommandResult serialization here. */
async function readSecret(arn: string, context: BackupTenantContext, signal?: AbortSignal): Promise<string> {
  assertBackupSecretScope(arn, context)
  if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
  const config = {
    region: context.region, credentials: fromNodeProviderChain(), ignoreConfiguredEndpointUrls: true,
    maxAttempts: 2, requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
  }
  const sts = new STSClient(config)
  const secrets = new SecretsManagerClient(config)
  const options = { abortSignal: signal ?? AbortSignal.timeout(60000) }
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}), options)
    if (identity.Account !== context.accountId) throw new Error('BACKUP_AWS_ACCOUNT_MISMATCH')
    if (options.abortSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: arn, VersionStage: 'AWSCURRENT' }), options)
    if (options.abortSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
    if (secret.SecretBinary !== undefined || typeof secret.SecretString !== 'string' || !secret.SecretString ||
      Buffer.byteLength(secret.SecretString) > 65536 || (secret.ARN !== undefined && secret.ARN !== arn)) throw new Error()
    return secret.SecretString
  } catch (error) {
    if (options.abortSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
    if (error instanceof Error && error.message === 'BACKUP_AWS_ACCOUNT_MISMATCH') throw error
    throw new Error('BACKUP_SOURCE_SECRET_UNAVAILABLE')
  } finally { sts.destroy(); secrets.destroy() }
}

export async function loadBackupExportConfiguration(secretArn: string, expected: BackupTenantContext, signal?: AbortSignal): Promise<BackupExportConfiguration> {
  const context = { ...expected }
  const raw = await readSecret(secretArn, context, signal)
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || !keys(value, ['version', 'databases', 'dynamodbStaging']) || value.version !== 1 ||
      !Array.isArray(value.databases) || value.databases.length > 100) throw new Error()
    const databases = value.databases.map((mapping) => { assertMapping(mapping, context); return { ...mapping } })
    const identities = databases.map((mapping) => JSON.stringify([mapping.resourceArn, mapping.name]))
    if (new Set(identities).size !== identities.length) throw new Error()
    if (value.dynamodbStaging !== undefined) {
      const staging = value.dynamodbStaging
      if (!record(staging) || !keys(staging, ['bucket', 'prefix']) || typeof staging.bucket !== 'string' ||
        !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(staging.bucket) ||
        typeof staging.prefix !== 'string' || Buffer.byteLength(staging.prefix) > 512 || /[\x00-\x1f\x7f]/.test(staging.prefix)) throw new Error()
      return { version: 1, databases, dynamodbStaging: { bucket: staging.bucket, prefix: staging.prefix } }
    }
    return { version: 1, databases }
  } catch { throw new Error('BACKUP_SOURCE_INVALID_CONFIGURATION') }
}

export async function loadBackupDatabaseConnection(mapping: BackupDatabaseMapping, discovered: BackupDatabaseEndpoint, expected: BackupTenantContext, signal?: AbortSignal): Promise<BackupDatabaseConnection> {
  const context = { ...expected }; const config = { ...mapping }; const endpoint = { ...discovered }
  assertMapping(config, context)
  const engine = ['postgres', 'aurora-postgresql'].includes(endpoint.engine) ? 'postgres' : ['mysql', 'aurora-mysql'].includes(endpoint.engine) ? 'mysql' : undefined
  const domain = context.region.startsWith('cn-') ? 'rds.amazonaws.com.cn' : 'rds.amazonaws.com'
  if (endpoint.resourceArn !== config.resourceArn || !engine || !text(endpoint.host, 253) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(endpoint.host) || !endpoint.host.endsWith(`.${context.region}.${domain}`) ||
    !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
    (engine === 'mysql' && config.mysqlConsistency === undefined) || (engine === 'postgres' && config.mysqlConsistency !== undefined)) throw new Error('BACKUP_SOURCE_INVALID_CONFIGURATION')
  const raw = await readSecret(config.credentialSecretArn, context, signal)
  let credentials: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(raw)
    if (!record(value) || !keys(value, ['username', 'password', 'host', 'port', 'engine', 'dbname', 'dbInstanceIdentifier', 'dbClusterIdentifier', 'masterarn']) ||
      !text(value.username, 128) || value.username.includes('*') || !text(value.password, 8192)) throw new Error()
    credentials = value
  } catch { throw new Error('BACKUP_DATABASE_SECRET_INVALID') }
  // Managed RDS master-user secrets can contain just username/password. When
  // endpoint identity fields are present, require agreement with Describe RDS.
  const resourceParts = endpoint.resourceArn.split(':')
  if ((credentials.dbInstanceIdentifier !== undefined && (resourceParts[5] !== 'db' || credentials.dbInstanceIdentifier !== resourceParts[6])) ||
    (credentials.dbClusterIdentifier !== undefined && (resourceParts[5] !== 'cluster' || credentials.dbClusterIdentifier !== resourceParts[6])) ||
    (credentials.host !== undefined && credentials.host !== endpoint.host) ||
    (credentials.port !== undefined && credentials.port !== endpoint.port) ||
    (credentials.engine !== undefined && credentials.engine !== engine && credentials.engine !== endpoint.engine) ||
    (credentials.dbname !== undefined && credentials.dbname !== config.name)) throw new Error('BACKUP_DATABASE_SECRET_MISMATCH')
  const caPem = await readSecret(config.caSecretArn, context, signal)
  try {
    const certificates = caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
    if (!certificates.length || certificates.length > 100 || caPem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw new Error()
    for (const certificate of certificates) if (!new X509Certificate(certificate).ca) throw new Error()
  } catch { throw new Error('BACKUP_DATABASE_CA_INVALID') }
  return { engine, host: endpoint.host, port: endpoint.port, database: config.name, username: credentials.username as string, password: credentials.password as string, caPem,
    ...(engine === 'mysql' ? { mysqlConsistency: config.mysqlConsistency } : {}),
  }
}
