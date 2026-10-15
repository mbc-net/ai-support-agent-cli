import { DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient, type CreateTableCommandInput, type KeySchemaElement, type Projection, type ProvisionedThroughputDescription } from '@aws-sdk/client-dynamodb'
import type { CompletedDynamoBackupExport } from './backup-dynamodb-export'
import type { BackupExportSource } from './backup-export-writer'
import { isScopedBackupResourceArn } from './backup-resource-selection'
import type { BackupTenantContext } from './backup-source-secrets'

const SAFE = new Set(['BACKUP_DYNAMODB_SCHEMA_CHANGED', 'BACKUP_DYNAMODB_SCHEMA_INVALID', 'BACKUP_EXPORT_ABORTED'])
function invalid(): never { throw new Error('BACKUP_DYNAMODB_SCHEMA_INVALID') }
function validName(value: unknown): value is string { return typeof value === 'string' && Buffer.byteLength(value) >= 1 && Buffer.byteLength(value) <= 255 }
function capacity(value?: ProvisionedThroughputDescription) {
  if (!Number.isSafeInteger(value?.ReadCapacityUnits) || value!.ReadCapacityUnits! < 1 || !Number.isSafeInteger(value?.WriteCapacityUnits) || value!.WriteCapacityUnits! < 1) invalid()
  return { ReadCapacityUnits: value!.ReadCapacityUnits!, WriteCapacityUnits: value!.WriteCapacityUnits! }
}
function projection(value?: Projection): Projection {
  if (!value || !['ALL', 'KEYS_ONLY', 'INCLUDE'].includes(value.ProjectionType ?? '')) invalid()
  if (value.ProjectionType !== 'INCLUDE') return { ProjectionType: value.ProjectionType }
  if (!value.NonKeyAttributes?.length || value.NonKeyAttributes.length > 100 || !value.NonKeyAttributes.every(validName) || new Set(value.NonKeyAttributes).size !== value.NonKeyAttributes.length) invalid()
  return { ProjectionType: 'INCLUDE', NonKeyAttributes: [...value.NonKeyAttributes] }
}

/** Capture observed configuration, not historical indexes/TTL at the data snapshot time. */
export async function captureDynamoBackupSchema(
  client: DynamoDBClient, expected: BackupTenantContext, input: CompletedDynamoBackupExport, signal?: AbortSignal,
): Promise<BackupExportSource> {
  const context = { ...expected }; const snapshot = { ...input }
  if (!/^\d{12}$/.test(context.accountId) || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(context.region) ||
    !isScopedBackupResourceArn(snapshot.tableArn, 'dynamodb', context) || !/^[a-fA-F0-9-]{36}$/.test(snapshot.tableId) ||
    !Number.isFinite(Date.parse(snapshot.exportTime))) invalid()
  const check = (): void => { if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED') }
  const options = { abortSignal: signal }
  try {
    check()
    const response = await client.send(new DescribeTableCommand({ TableName: snapshot.tableArn }), options)
    check()
    const table = response.Table
    if (!table || table.TableArn !== snapshot.tableArn || table.TableId !== snapshot.tableId || table.TableName !== snapshot.tableArn.split('/')[1] || table.TableStatus !== 'ACTIVE' ||
      table.GlobalSecondaryIndexes?.some((index) => index.IndexStatus !== 'ACTIVE' || index.Backfilling)) throw new Error('BACKUP_DYNAMODB_SCHEMA_CHANGED')
    const attributes = table.AttributeDefinitions
    if (!attributes?.length || attributes.length > 100 || attributes.some((a) => !validName(a.AttributeName) || !['S', 'N', 'B'].includes(a.AttributeType ?? '')) ||
      new Set(attributes.map((a) => a.AttributeName)).size !== attributes.length) invalid()
    const defined = new Set(attributes.map((a) => a.AttributeName))
    const used = new Set<string>()
    const keys = (schema?: KeySchemaElement[]): KeySchemaElement[] => {
      if (!schema || schema.length < 1 || schema.length > 2 || schema.filter((key) => key.KeyType === 'HASH').length !== 1 ||
        schema.some((key) => !validName(key.AttributeName) || !defined.has(key.AttributeName) || (key.KeyType !== 'HASH' && key.KeyType !== 'RANGE')) ||
        new Set(schema.map((key) => key.AttributeName)).size !== schema.length) invalid()
      for (const key of schema) used.add(key.AttributeName!)
      return schema.map(({ AttributeName, KeyType }) => ({ AttributeName, KeyType }))
    }
    const billing = table.BillingModeSummary?.BillingMode ?? 'PROVISIONED'
    if (billing !== 'PROVISIONED' && billing !== 'PAY_PER_REQUEST') invalid()
    const definition: CreateTableCommandInput = {
      TableName: table.TableName, KeySchema: keys(table.KeySchema),
      AttributeDefinitions: attributes.map(({ AttributeName, AttributeType }) => ({ AttributeName, AttributeType })),
      BillingMode: billing,
      ...(billing === 'PROVISIONED' ? { ProvisionedThroughput: capacity(table.ProvisionedThroughput) } : {}),
    }
    const indexNames = new Set<string>()
    const indexName = (name?: string): string => {
      if (!name || !/^[a-zA-Z0-9_.-]{3,255}$/.test(name) || indexNames.has(name)) invalid()
      indexNames.add(name); return name
    }
    if (table.LocalSecondaryIndexes?.length) {
      if (table.LocalSecondaryIndexes.length > 5) invalid()
      definition.LocalSecondaryIndexes = table.LocalSecondaryIndexes.map((index) => ({ IndexName: indexName(index.IndexName), KeySchema: keys(index.KeySchema), Projection: projection(index.Projection) }))
      const hash = definition.KeySchema!.find((key) => key.KeyType === 'HASH')!.AttributeName
      if (definition.KeySchema!.length !== 2 || definition.LocalSecondaryIndexes.some((index) => index.KeySchema!.length !== 2 || index.KeySchema!.find((key) => key.KeyType === 'HASH')!.AttributeName !== hash)) invalid()
    }
    if (table.GlobalSecondaryIndexes?.length) {
      if (table.GlobalSecondaryIndexes.length > 100) invalid()
      definition.GlobalSecondaryIndexes = table.GlobalSecondaryIndexes.map((index) => ({ IndexName: indexName(index.IndexName), KeySchema: keys(index.KeySchema), Projection: projection(index.Projection),
        ...(billing === 'PROVISIONED' ? { ProvisionedThroughput: capacity(index.ProvisionedThroughput) } : {}),
      }))
    }
    if (defined.size !== used.size) invalid()
    if (table.StreamSpecification?.StreamEnabled) {
      if (!['KEYS_ONLY', 'NEW_IMAGE', 'OLD_IMAGE', 'NEW_AND_OLD_IMAGES'].includes(table.StreamSpecification.StreamViewType ?? '')) invalid()
      definition.StreamSpecification = { StreamEnabled: true, StreamViewType: table.StreamSpecification.StreamViewType }
    }
    if (table.TableClassSummary?.TableClass) definition.TableClass = table.TableClassSummary.TableClass
    if (typeof table.DeletionProtectionEnabled === 'boolean') definition.DeletionProtectionEnabled = table.DeletionProtectionEnabled
    const ttl = (await client.send(new DescribeTimeToLiveCommand({ TableName: snapshot.tableArn }), options)).TimeToLiveDescription
    check()
    if (ttl?.TimeToLiveStatus !== 'ENABLED' && ttl?.TimeToLiveStatus !== 'DISABLED') throw new Error('BACKUP_DYNAMODB_SCHEMA_CHANGED')
    if (ttl.TimeToLiveStatus === 'ENABLED' && !validName(ttl.AttributeName)) invalid()
    const after = (await client.send(new DescribeTableCommand({ TableName: snapshot.tableArn }), options)).Table
    check()
    if (after?.TableArn !== snapshot.tableArn || after.TableId !== snapshot.tableId || after.TableStatus !== 'ACTIVE') throw new Error('BACKUP_DYNAMODB_SCHEMA_CHANGED')
    const bytes = Buffer.from(JSON.stringify({
      version: 1, tableArn: snapshot.tableArn, tableId: snapshot.tableId, dataSnapshotTime: snapshot.exportTime,
      schemaObservedAt: new Date().toISOString(), createTable: definition,
      timeToLive: ttl.TimeToLiveStatus === 'ENABLED' ? { Enabled: true, AttributeName: ttl.AttributeName } : { Enabled: false },
    }))
    if (bytes.length > 1024 * 1024) invalid()
    return { resourceArn: snapshot.tableArn, name: `${snapshot.manifestKey.slice(0, snapshot.manifestKey.lastIndexOf('/') + 1)}table-schema.json`, format: 'dynamodb-schema',
      open: async function* (activeSignal) { if (activeSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED'); yield bytes; if (activeSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED') },
    }
  } catch (error) {
    check()
    throw new Error(error instanceof Error && SAFE.has(error.message) ? error.message : 'BACKUP_DYNAMODB_SCHEMA_FAILED')
  }
}
