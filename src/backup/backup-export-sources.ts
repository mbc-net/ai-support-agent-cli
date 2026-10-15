import type { S3Client } from '@aws-sdk/client-s3'
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { loadBackupDatabaseConnection, type BackupExportConfiguration, type BackupTenantContext } from './backup-source-secrets'
import type { ResolvedBackupResource } from './backup-resource-selection'
import type { BackupExportSource } from './backup-export-writer'
import { streamDatabaseDump } from './backup-database-dump'
import { listBackupS3Objects, streamBackupS3Object } from './backup-s3-source'
import { startDynamoBackupExport } from './backup-dynamodb-export'
import { captureDynamoBackupSchema } from './backup-dynamodb-schema'
import { enumerateDynamoBackupSources } from './backup-dynamodb-source'

/** Internal adapter: selection and configuration must already have passed their scoped validators.
 * The writer supplies the common deadline signal and enforces aggregate byte/object limits.
 */
export async function* enumerateBackupExportSources(
  expected: BackupTenantContext, selected: ResolvedBackupResource[], configuration: BackupExportConfiguration,
  clients: { s3(): S3Client; dynamodb(): DynamoDBClient },
  limits: { runId: string; exportTime: Date; maxObjects: number; maxObjectBytes: number; timeoutMs: number },
  signal: AbortSignal,
): AsyncGenerator<BackupExportSource> {
  const check = (): void => { if (signal.aborted) throw new Error('BACKUP_EXPORT_ABORTED') }
  check()
  const context = { ...expected }
  const resources = selected.map(resource => ({ ...resource, database: resource.database && { ...resource.database } }))
  const config = { ...configuration, databases: configuration.databases.map(mapping => ({ ...mapping })), dynamodbStaging: configuration.dynamodbStaging && { ...configuration.dynamodbStaging } }
  const options = { ...limits, exportTime: new Date(limits.exportTime) }
  if (!resources.length) throw new Error('BACKUP_EXPORT_SELECTION_EMPTY')
  // Validate the whole selection before the writer stores even the inventory.
  for (const resource of resources) {
    if (resource.type === 'rds' || resource.type === 'aurora') {
      if (!resource.database || resource.database.resourceArn !== resource.arn || !config.databases.some(mapping => mapping.resourceArn === resource.arn)) throw new Error('BACKUP_SOURCE_MAPPING_REQUIRED')
      if (!['postgres', 'aurora-postgresql', 'mysql', 'aurora-mysql'].includes(resource.database.engine)) throw new Error('BACKUP_EXPORT_ENGINE_UNSUPPORTED')
      const mysql = resource.database.engine === 'mysql' || resource.database.engine === 'aurora-mysql'
      for (const mapping of config.databases.filter(item => item.resourceArn === resource.arn)) {
        if (mysql ? !['innodb-no-ddl', 'global-read-lock'].includes(mapping.mysqlConsistency ?? '') : mapping.mysqlConsistency !== undefined) throw new Error('BACKUP_SOURCE_INVALID_CONFIGURATION')
      }
    } else if (resource.type === 'dynamodb') {
      if (!config.dynamodbStaging) throw new Error('BACKUP_DYNAMODB_STAGING_REQUIRED')
    } else if (resource.type !== 's3' || !resource.bucket) throw new Error('BACKUP_EXPORT_INVALID_SOURCE')
  }
  const inventory = Buffer.from(JSON.stringify({ version: 1, resources: resources.map(({ type, arn }) => ({ type, arn })) }))
  yield {
    resourceArn: resources[0].arn, name: 'resource-inventory.json', format: 'resource-inventory',
    open: async function* (activeSignal) { if (activeSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED'); yield inventory },
  }
  for (const resource of resources) {
    check()
    if (resource.type === 'rds' || resource.type === 'aurora') {
      const endpoint = resource.database!
      for (const mapping of config.databases.filter(item => item.resourceArn === resource.arn)) {
        yield {
          resourceArn: resource.arn, name: mapping.name,
          format: endpoint.engine === 'postgres' || endpoint.engine === 'aurora-postgresql' ? 'postgres-custom' : 'mysql-sql',
          open: async function* (activeSignal) {
            const connection = await loadBackupDatabaseConnection(mapping, endpoint, context, activeSignal)
            yield* streamDatabaseDump(connection, { maxBytes: options.maxObjectBytes, timeoutMs: options.timeoutMs, signal: activeSignal })
          },
        }
      }
    } else if (resource.type === 's3') {
      const s3 = clients.s3()
      for await (const object of listBackupS3Objects(s3, { bucket: resource.bucket!, accountId: context.accountId, prefix: '', maxObjects: options.maxObjects, maxObjectBytes: options.maxObjectBytes }, signal)) {
        const snapshot = { ...object }
        yield { resourceArn: resource.arn, name: snapshot.key, format: 's3-object', open: activeSignal => streamBackupS3Object(s3, snapshot, activeSignal) }
      }
    } else {
      const s3 = clients.s3(); const dynamodb = clients.dynamodb()
      const completed = await startDynamoBackupExport(dynamodb, s3, context, { tableArn: resource.arn, ...config.dynamodbStaging!, runId: options.runId, exportTime: options.exportTime, timeoutMs: options.timeoutMs }, signal)
      yield await captureDynamoBackupSchema(dynamodb, context, completed, signal)
      yield* enumerateDynamoBackupSources(s3, context, completed, { maxFiles: options.maxObjects, maxObjectBytes: options.maxObjectBytes }, signal)
    }
  }
  check()
}
