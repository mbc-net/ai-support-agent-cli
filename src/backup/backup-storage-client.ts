import { S3Client } from '@aws-sdk/client-s3'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'

export interface BackupStorageConfiguration {
  provider: string
  endpoint: string
  region: string
  writeCredentialSecretArn: string
}

export function validateBackupStorageConfiguration(config: BackupStorageConfiguration, expected: { accountId: string; region: string }): string {
  if (config.provider !== 'wasabi' && config.provider !== 'backblaze_b2') throw new Error('BACKUP_STORAGE_PROVIDER_UNSUPPORTED')
  try {
    const endpoint = new URL(config.endpoint)
    const host = config.provider === 'wasabi'
      ? /^s3(?:\.[a-z0-9-]+)?\.wasabisys\.com$/
      : /^s3\.[a-z0-9-]+\.backblazeb2\.com$/
    if (endpoint.protocol !== 'https:' || endpoint.port || endpoint.username || endpoint.password ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash || !host.test(endpoint.hostname) ||
      !/^[a-z0-9-]{1,63}$/.test(config.region)) throw new Error()
    if (!/^\d{12}$/.test(expected.accountId) || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(expected.region)) throw new Error()
    const partition = expected.region.startsWith('cn-') ? 'aws-cn' : expected.region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws'
    const arn = config.writeCredentialSecretArn.match(/^arn:(aws|aws-cn|aws-us-gov):secretsmanager:([a-z0-9-]+):(\d{12}):secret:([A-Za-z0-9/_+=.@-]+)$/)
    if (!arn || config.writeCredentialSecretArn.length > 2048 || arn[1] !== partition || arn[2] !== expected.region || arn[3] !== expected.accountId) throw new Error()
    return endpoint.origin
  } catch {
    throw new Error('BACKUP_STORAGE_INVALID_CONFIGURATION')
  }
}

function parseCredentials(raw: string | undefined): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } {
  if (!raw || raw.length > 16384) throw new Error()
  const value: unknown = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
  const data = value as Record<string, unknown>
  const text = (input: unknown, max: number): input is string => typeof input === 'string' && input.length > 0 && input.length <= max && /^[\x21-\x7e]+$/.test(input)
  if (Object.keys(data).some((key) => !['accessKeyId', 'secretAccessKey', 'sessionToken'].includes(key)) ||
    !text(data.accessKeyId, 1024) || !text(data.secretAccessKey, 4096) ||
    (data.sessionToken !== undefined && !text(data.sessionToken, 8192))) throw new Error()
  return { accessKeyId: data.accessKeyId, secretAccessKey: data.secretAccessKey, ...(data.sessionToken ? { sessionToken: data.sessionToken as string } : {}) }
}

/** Caller owns and destroys the returned client; no credential values may leave the tenant agent. */
export async function createBackupStorageClient(
  destination: BackupStorageConfiguration,
  expected: { accountId: string; region: string },
  signal?: AbortSignal,
): Promise<S3Client> {
  // Copy validated fields before async work. Do not follow a caller mutating them.
  const config = { ...destination }
  const context = { ...expected }
  const endpoint = validateBackupStorageConfiguration(config, context)
  if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
  const aws = {
    region: context.region, credentials: fromNodeProviderChain(), ignoreConfiguredEndpointUrls: true,
    maxAttempts: 2, requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
  }
  const sts = new STSClient(aws)
  const secrets = new SecretsManagerClient(aws)
  const options = { abortSignal: signal ?? AbortSignal.timeout(60000) }
  try {
    const identity = await sts.send(new GetCallerIdentityCommand({}), options)
    if (identity.Account !== context.accountId) throw new Error('BACKUP_AWS_ACCOUNT_MISMATCH')
    if (options.abortSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: config.writeCredentialSecretArn, VersionStage: 'AWSCURRENT' }), options)
    const credentials = parseCredentials(secret.SecretString)
    if (options.abortSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
    return new S3Client({
      endpoint, region: config.region, credentials, forcePathStyle: true, followRegionRedirects: false,
      ignoreConfiguredEndpointUrls: true, maxAttempts: 3, retryMode: 'standard',
      // Avoid optional AWS-specific checksum extensions on S3-compatible storage.
      // UploadPart explicitly supplies Content-MD5; manifests retain SHA-256.
      requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
    })
  } catch (error) {
    if (options.abortSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
    if (error instanceof Error && error.message === 'BACKUP_AWS_ACCOUNT_MISMATCH') throw error
    throw new Error('BACKUP_STORAGE_CREDENTIALS_UNAVAILABLE')
  } finally {
    sts.destroy()
    secrets.destroy()
  }
}
