import { DescribeContinuousBackupsCommand, DescribeExportCommand, DynamoDBClient, ExportTableToPointInTimeCommand, type DescribeExportCommandOutput, type ExportDescription } from '@aws-sdk/client-dynamodb'
import { GetBucketLocationCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { createHash } from 'crypto'
import { setTimeout as delay } from 'timers/promises'
import { isScopedBackupResourceArn } from './backup-resource-selection'
import type { BackupTenantContext } from './backup-source-secrets'

export interface DynamoBackupExportRequest {
  tableArn: string
  runId: string
  /** Fixed across retries; must fall within the table's current PITR window. */
  exportTime: Date
  bucket: string
  prefix: string
  timeoutMs: number
  pollIntervalMs?: number
}
export interface CompletedDynamoBackupExport {
  tableArn: string
  tableId: string
  exportArn: string
  exportTime: string
  bucket: string
  prefix: string
  manifestKey: string
  itemCount: number
}
const SAFE = new Set(['BACKUP_DYNAMODB_PITR_REQUIRED', 'BACKUP_DYNAMODB_SNAPSHOT_UNAVAILABLE', 'BACKUP_DYNAMODB_STAGING_MISMATCH', 'BACKUP_DYNAMODB_EXPORT_MISMATCH', 'BACKUP_DYNAMODB_EXPORT_FAILED'])

/** Clients must come from the tenant resource adapter after its STS gate. */
export async function startDynamoBackupExport(
  dynamodb: DynamoDBClient, s3: S3Client, expected: BackupTenantContext, input: DynamoBackupExportRequest, signal?: AbortSignal,
): Promise<CompletedDynamoBackupExport> {
  const context = { ...expected }
  const config = { ...input, exportTime: new Date(input.exportTime.getTime()) }
  const pollInterval = config.pollIntervalMs ?? 10000
  if (!/^\d{12}$/.test(context.accountId) || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(context.region) ||
    !isScopedBackupResourceArn(config.tableArn, 'dynamodb', context) || !/^[A-Za-z0-9_-]{1,100}$/.test(config.runId) ||
    !Number.isFinite(config.exportTime.getTime()) || config.exportTime.getTime() > Date.now() ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || typeof config.prefix !== 'string' ||
    Buffer.byteLength(config.prefix) > 512 || /[\x00-\x1f\x7f]/.test(config.prefix) ||
    !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 21600000 ||
    !Number.isInteger(pollInterval) || pollInterval < 1 || pollInterval > 60000) throw new Error('BACKUP_DYNAMODB_INVALID_CONFIGURATION')
  const controller = new AbortController()
  let timedOut = false
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, config.timeoutMs)
  const check = (): void => { if (controller.signal.aborted) throw new Error(timedOut ? 'BACKUP_EXPORT_TIMEOUT' : 'BACKUP_EXPORT_ABORTED') }
  const options = { abortSignal: controller.signal }
  const token = createHash('sha256').update(JSON.stringify([config.runId, config.tableArn, config.exportTime.toISOString(), config.bucket, config.prefix])).digest('hex')
  const prefix = `${config.prefix}${config.prefix && !config.prefix.endsWith('/') ? '/' : ''}${config.runId}/${token}`
  try {
    check()
    await s3.send(new HeadBucketCommand({ Bucket: config.bucket, ExpectedBucketOwner: context.accountId }), options)
    const location = await s3.send(new GetBucketLocationCommand({ Bucket: config.bucket, ExpectedBucketOwner: context.accountId }), options)
    const region = location.LocationConstraint === 'EU' ? 'eu-west-1' : location.LocationConstraint || 'us-east-1'
    if (region !== context.region) throw new Error('BACKUP_DYNAMODB_STAGING_MISMATCH')
    check()
    const backups = await dynamodb.send(new DescribeContinuousBackupsCommand({ TableName: config.tableArn }), options)
    const pitr = backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
    if (pitr?.PointInTimeRecoveryStatus !== 'ENABLED') throw new Error('BACKUP_DYNAMODB_PITR_REQUIRED')
    const earliest = pitr.EarliestRestorableDateTime?.getTime(); const latest = pitr.LatestRestorableDateTime?.getTime()
    if (!Number.isFinite(earliest) || !Number.isFinite(latest) || config.exportTime.getTime() < earliest! || config.exportTime.getTime() > latest!) throw new Error('BACKUP_DYNAMODB_SNAPSHOT_UNAVAILABLE')
    check()
    const started = await dynamodb.send(new ExportTableToPointInTimeCommand({
      TableArn: config.tableArn, ClientToken: token, ExportTime: config.exportTime, ExportType: 'FULL_EXPORT', ExportFormat: 'DYNAMODB_JSON',
      S3Bucket: config.bucket, S3BucketOwner: context.accountId, S3Prefix: prefix, S3SseAlgorithm: 'AES256',
    }), options)
    const exportArn = started.ExportDescription?.ExportArn
    if (!exportArn || !exportArn.startsWith(`${config.tableArn}/export/`) || !/^[A-Za-z0-9-]+$/.test(exportArn.slice(`${config.tableArn}/export/`.length))) throw new Error('BACKUP_DYNAMODB_EXPORT_MISMATCH')
    const exportId = exportArn.slice(`${config.tableArn}/export/`.length)
    while (true) {
      check()
      const response: DescribeExportCommandOutput = await dynamodb.send(new DescribeExportCommand({ ExportArn: exportArn }), options)
      check()
      const result: ExportDescription | undefined = response.ExportDescription
      if (!result || result.ExportArn !== exportArn || result.TableArn !== config.tableArn || result.S3Bucket !== config.bucket ||
        result.S3BucketOwner !== context.accountId || result.S3Prefix !== prefix || result.ExportType !== 'FULL_EXPORT' ||
        result.ExportFormat !== 'DYNAMODB_JSON' || result.S3SseAlgorithm !== 'AES256' || result.ExportTime?.getTime() !== config.exportTime.getTime() ||
        result.FilterSpecification !== undefined || result.IncrementalExportSpecification !== undefined) throw new Error('BACKUP_DYNAMODB_EXPORT_MISMATCH')
      if (result.ExportStatus === 'COMPLETED') {
        const manifestKey = `${prefix}/AWSDynamoDB/${exportId}/manifest-summary.json`
        if (result.ExportManifest !== manifestKey || !Number.isSafeInteger(result.ItemCount) || result.ItemCount! < 0 || !result.TableId ||
          !/^[a-fA-F0-9-]{36}$/.test(result.TableId)) throw new Error('BACKUP_DYNAMODB_EXPORT_MISMATCH')
        return { tableArn: config.tableArn, tableId: result.TableId, exportArn, exportTime: config.exportTime.toISOString(), bucket: config.bucket, prefix, manifestKey, itemCount: result.ItemCount! }
      }
      if (result.ExportStatus !== 'IN_PROGRESS') throw new Error('BACKUP_DYNAMODB_EXPORT_FAILED')
      await delay(pollInterval, undefined, { signal: controller.signal })
    }
  } catch (error) {
    check()
    throw new Error(error instanceof Error && SAFE.has(error.message) ? error.message : 'BACKUP_DYNAMODB_EXPORT_FAILED')
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    // DynamoDB has no cancel-export operation. Timeout stops local polling only;
    // staging files may still appear and require the tenant's lifecycle policy.
    controller.abort()
  }
}
