import { DescribeContinuousBackupsCommand, DescribeExportCommand, DynamoDBClient, ExportTableToPointInTimeCommand } from '@aws-sdk/client-dynamodb'
import { GetBucketLocationCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { startDynamoBackupExport } from '../../src/backup/backup-dynamodb-export'

const context = { accountId: '123456789012', region: 'ap-northeast-1' }
const tableArn = 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/app'
const exportArn = `${tableArn}/export/01234567890123-abcdef12`
const input = () => ({ tableArn, runId: 'command-123', exportTime: new Date('2026-01-01T00:00:00Z'), bucket: 'tenant-staging', prefix: 'backup/', timeoutMs: 10000, pollIntervalMs: 1 })

describe('DynamoDB full export lifecycle', () => {
  const dynamodb = new DynamoDBClient({ region: context.region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  const s3 = new S3Client({ region: context.region, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } })
  const db = mockClient(dynamodb); const storage = mockClient(s3)
  let started: Record<string, any>
  beforeEach(() => {
    db.reset(); storage.reset(); started = {}
    storage.on(HeadBucketCommand).resolves({})
    storage.on(GetBucketLocationCommand).resolves({ LocationConstraint: context.region as 'ap-northeast-1' })
    db.on(DescribeContinuousBackupsCommand).resolves({ ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'ENABLED', EarliestRestorableDateTime: new Date('2025-12-31'), LatestRestorableDateTime: new Date('2026-01-02') } } })
    db.on(ExportTableToPointInTimeCommand).callsFake((request) => { started = request; return { ExportDescription: { ExportArn: exportArn } } })
    db.on(DescribeExportCommand).callsFake(() => ({ ExportDescription: { ...started, ExportArn: exportArn, ExportStatus: 'COMPLETED', ExportManifest: `${started.S3Prefix}/AWSDynamoDB/01234567890123-abcdef12/manifest-summary.json`, TableId: '12345678-1234-1234-1234-123456789012', ItemCount: 2 } }))
  })
  afterAll(() => { db.restore(); storage.restore(); dynamodb.destroy(); s3.destroy() })
  it('pins a full snapshot, staging owner and encryption, then validates completion', async () => {
    const result = await startDynamoBackupExport(dynamodb, s3, context, input())
    expect(started).toMatchObject({ TableArn: tableArn, ExportTime: input().exportTime, ExportType: 'FULL_EXPORT', ExportFormat: 'DYNAMODB_JSON', S3BucketOwner: context.accountId, S3SseAlgorithm: 'AES256' })
    expect(result).toMatchObject({ tableArn, exportArn, bucket: 'tenant-staging', itemCount: 2, manifestKey: expect.stringContaining('/manifest-summary.json') })
    expect(storage.commandCalls(HeadBucketCommand)[0].args[0].input.ExpectedBucketOwner).toBe(context.accountId)
  })
  it('uses the same request token and prefix when retrying an unchanged snapshot', async () => {
    await startDynamoBackupExport(dynamodb, s3, context, input())
    const first = { ...started }
    await startDynamoBackupExport(dynamodb, s3, context, input())
    expect(started).toEqual(first)
  })
  it('does not start an export if PITR is disabled', async () => {
    db.on(DescribeContinuousBackupsCommand).resolves({ ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: 'DISABLED' } } })
    await expect(startDynamoBackupExport(dynamodb, s3, context, input())).rejects.toThrow('BACKUP_DYNAMODB_PITR_REQUIRED')
    expect(db.commandCalls(ExportTableToPointInTimeCommand)).toHaveLength(0)
  })
  it('rejects a snapshot outside the restorable interval', async () => {
    await expect(startDynamoBackupExport(dynamodb, s3, context, { ...input(), exportTime: new Date('2025-01-01') })).rejects.toThrow('BACKUP_DYNAMODB_SNAPSHOT_UNAVAILABLE')
    expect(db.commandCalls(ExportTableToPointInTimeCommand)).toHaveLength(0)
  })
  it('rejects staging in a different region', async () => {
    storage.on(GetBucketLocationCommand).resolves({ LocationConstraint: 'us-west-2' })
    await expect(startDynamoBackupExport(dynamodb, s3, context, input())).rejects.toThrow('BACKUP_DYNAMODB_STAGING_MISMATCH')
    expect(db.commandCalls(ExportTableToPointInTimeCommand)).toHaveLength(0)
  })
  it('polls IN_PROGRESS and observes the deadline without claiming export cancellation', async () => {
    db.on(DescribeExportCommand).callsFake(() => ({ ExportDescription: { ...started, ExportArn: exportArn, ExportStatus: 'IN_PROGRESS' } }))
    await expect(startDynamoBackupExport(dynamodb, s3, context, { ...input(), timeoutMs: 20 })).rejects.toThrow('BACKUP_EXPORT_TIMEOUT')
    expect(db.commandCalls(DescribeExportCommand).length).toBeGreaterThan(0)
  })
  it.each(['FAILED', 'UNKNOWN'])('rejects status %s without provider error details', async (ExportStatus) => {
    db.on(DescribeExportCommand).callsFake(() => ({ ExportDescription: { ...started, ExportArn: exportArn, ExportStatus, FailureMessage: 'sensitive message' } }))
    await expect(startDynamoBackupExport(dynamodb, s3, context, input())).rejects.toThrow(/^BACKUP_DYNAMODB_EXPORT_FAILED$/)
  })
  it('rejects a completed export for a different table', async () => {
    db.on(DescribeExportCommand).callsFake(() => ({ ExportDescription: { ...started, TableArn: `${tableArn}-other`, ExportArn: exportArn, ExportStatus: 'COMPLETED' } }))
    await expect(startDynamoBackupExport(dynamodb, s3, context, input())).rejects.toThrow('BACKUP_DYNAMODB_EXPORT_MISMATCH')
  })
  it('does not read an export ARN outside the selected table', async () => {
    db.on(ExportTableToPointInTimeCommand).resolves({ ExportDescription: { ExportArn: exportArn.replace('123456789012', '999999999999') } })
    await expect(startDynamoBackupExport(dynamodb, s3, context, input())).rejects.toThrow('BACKUP_DYNAMODB_EXPORT_MISMATCH')
    expect(db.commandCalls(DescribeExportCommand)).toHaveLength(0)
  })
  it('refuses an unexpectedly filtered full export', async () => {
    db.on(DescribeExportCommand).callsFake(() => ({ ExportDescription: { ...started, ExportArn: exportArn, ExportStatus: 'COMPLETED', ExportManifest: `${started.S3Prefix}/AWSDynamoDB/01234567890123-abcdef12/manifest-summary.json`, TableId: '12345678-1234-1234-1234-123456789012', ItemCount: 2, FilterSpecification: { FilterExpression: 'attribute_exists(id)' } } }))
    await expect(startDynamoBackupExport(dynamodb, s3, context, input())).rejects.toThrow('BACKUP_DYNAMODB_EXPORT_MISMATCH')
  })
})
