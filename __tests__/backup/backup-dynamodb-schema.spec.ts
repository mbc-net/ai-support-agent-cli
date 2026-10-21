import { DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { mockClient } from 'aws-sdk-client-mock'
import { captureDynamoBackupSchema } from '../../src/backup/backup-dynamodb-schema'

const context = { accountId: '123456789012', region: 'ap-northeast-1' }
const tableArn = 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/app'
const completed = { tableArn, tableId: '12345678-1234-1234-1234-123456789012', exportArn: `${tableArn}/export/01234567890123-abcdef12`, exportTime: '2026-01-01T00:00:00.000Z', bucket: 'tenant-staging', prefix: 'backup/run', manifestKey: 'backup/run/AWSDynamoDB/01234567890123-abcdef12/manifest-summary.json', itemCount: 1 }
const table = () => ({ TableArn: tableArn, TableId: completed.tableId, TableName: 'app', TableStatus: 'ACTIVE' as const, KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }], AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' as const }, { AttributeName: 'category', AttributeType: 'S' as const }], BillingModeSummary: { BillingMode: 'PAY_PER_REQUEST' as const }, GlobalSecondaryIndexes: [{ IndexName: 'category-index', IndexStatus: 'ACTIVE' as const, KeySchema: [{ AttributeName: 'category', KeyType: 'HASH' as const }], Projection: { ProjectionType: 'ALL' as const } }] })
describe('DynamoDB restoration schema capture', () => {
  const client = new DynamoDBClient({ region: context.region, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' } })
  const aws = mockClient(client)
  beforeEach(() => {
    aws.reset()
    aws.on(DescribeTableCommand).resolves({ Table: table() })
    aws.on(DescribeTimeToLiveCommand).resolves({ TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'expiresAt' } })
  })
  afterAll(() => { aws.restore(); client.destroy() })
  it('captures key types, indexes, billing and TTL as an encrypted-source descriptor', async () => {
    const source = await captureDynamoBackupSchema(client, context, completed)
    const bytes: Buffer[] = []; for await (const part of source.open(new AbortController().signal)) bytes.push(Buffer.from(part))
    const schema = JSON.parse(Buffer.concat(bytes).toString())
    expect(source.format).toBe('dynamodb-schema')
    expect(schema).toMatchObject({ version: 1, tableArn, tableId: completed.tableId, dataSnapshotTime: completed.exportTime,
      createTable: { TableName: 'app', BillingMode: 'PAY_PER_REQUEST', KeySchema: table().KeySchema, AttributeDefinitions: table().AttributeDefinitions, GlobalSecondaryIndexes: [{ IndexName: 'category-index', KeySchema: table().GlobalSecondaryIndexes[0].KeySchema, Projection: { ProjectionType: 'ALL' } }] },
      timeToLive: { Enabled: true, AttributeName: 'expiresAt' },
    })
    expect(schema.createTable.TableStatus).toBeUndefined()
    expect(schema.createTable.GlobalSecondaryIndexes[0].IndexStatus).toBeUndefined()
    expect(Number.isFinite(Date.parse(schema.schemaObservedAt))).toBe(true)
  })
  it('rejects a deleted and recreated table even when the ARN is unchanged', async () => {
    aws.on(DescribeTableCommand).resolves({ Table: { ...table(), TableId: 'aaaaaaaa-1234-1234-1234-123456789012' } })
    await expect(captureDynamoBackupSchema(client, context, completed)).rejects.toThrow('BACKUP_DYNAMODB_SCHEMA_CHANGED')
  })
  it('detects recreation between table definition and TTL reads', async () => {
    aws.on(DescribeTableCommand).resolvesOnce({ Table: table() }).resolves({ Table: { ...table(), TableId: 'aaaaaaaa-1234-1234-1234-123456789012' } })
    await expect(captureDynamoBackupSchema(client, context, completed)).rejects.toThrow('BACKUP_DYNAMODB_SCHEMA_CHANGED')
  })
  it('refuses a changing index definition', async () => {
    aws.on(DescribeTableCommand).resolves({ Table: { ...table(), GlobalSecondaryIndexes: [{ ...table().GlobalSecondaryIndexes[0], IndexStatus: 'CREATING' }] } })
    await expect(captureDynamoBackupSchema(client, context, completed)).rejects.toThrow('BACKUP_DYNAMODB_SCHEMA_CHANGED')
  })
  it('rejects missing attribute type definitions', async () => {
    aws.on(DescribeTableCommand).resolves({ Table: { ...table(), AttributeDefinitions: [] } })
    await expect(captureDynamoBackupSchema(client, context, completed)).rejects.toThrow('BACKUP_DYNAMODB_SCHEMA_INVALID')
  })
  it('rejects a transitioning TTL setting', async () => {
    aws.on(DescribeTimeToLiveCommand).resolves({ TimeToLiveDescription: { TimeToLiveStatus: 'ENABLING', AttributeName: 'expiresAt' } })
    await expect(captureDynamoBackupSchema(client, context, completed)).rejects.toThrow('BACKUP_DYNAMODB_SCHEMA_CHANGED')
  })
  it('does not expose SDK error text', async () => {
    aws.on(DescribeTableCommand).rejects(new Error('private credential failure'))
    await expect(captureDynamoBackupSchema(client, context, completed)).rejects.toThrow(/^BACKUP_DYNAMODB_SCHEMA_FAILED$/)
  })
})
