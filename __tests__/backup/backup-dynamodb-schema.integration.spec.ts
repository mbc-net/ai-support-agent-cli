import { CreateTableCommand, DeleteTableCommand, DescribeTableCommand, DescribeTimeToLiveCommand, DynamoDBClient, PutItemCommand, QueryCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb'
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomUUID } from 'crypto'
import { mockClient } from 'aws-sdk-client-mock'
import { captureDynamoBackupSchema } from '../../src/backup/backup-dynamodb-schema'
import { encryptBackupStream } from '../../src/backup/backup-envelope'

const endpoint = process.env.BYO_BACKUP_DYNAMODB_TEST_ENDPOINT
const integration = endpoint ? describe : describe.skip
integration('DynamoDB restoration schema on DynamoDB Local', () => {
  it.each(['PAY_PER_REQUEST', 'PROVISIONED'] as const)('creates a usable restored table and secondary index with %s', async (billing) => {
    if (!endpoint || !['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname)) throw new Error('Only a local test endpoint is allowed')
    const context = { accountId: '123456789012', region: 'ap-northeast-1' }
    const credentials = { accessKeyId: 'fixture', secretAccessKey: 'fixture' }
    const observed = new DynamoDBClient({ region: context.region, credentials })
    const local = new DynamoDBClient({ region: context.region, credentials, endpoint })
    const aws = mockClient(observed)
    const tableName = `backup_schema_${randomUUID().replace(/-/g, '')}`
    const tableArn = `arn:aws:dynamodb:${context.region}:${context.accountId}:table/${tableName}`
    const tableId = '12345678-1234-1234-1234-123456789012'
    aws.on(DescribeTableCommand).resolves({ Table: {
      TableArn: tableArn, TableName: tableName, TableId: tableId, TableStatus: 'ACTIVE', BillingModeSummary: { BillingMode: billing },
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }, { AttributeName: 'category', AttributeType: 'S' }],
      ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 3 },
      GlobalSecondaryIndexes: [{ IndexName: 'category-index', IndexStatus: 'ACTIVE', KeySchema: [{ AttributeName: 'category', KeyType: 'HASH' }], Projection: { ProjectionType: 'ALL' }, ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }],
    } })
    aws.on(DescribeTimeToLiveCommand).resolves({ TimeToLiveDescription: { TimeToLiveStatus: 'DISABLED' } })
    let created = false
    try {
      const source = await captureDynamoBackupSchema(observed, context, { tableArn, tableId, exportArn: `${tableArn}/export/01234567890123-abcdef12`, exportTime: '2026-01-01T00:00:00Z', bucket: 'tenant-staging', prefix: 'run', manifestKey: 'run/AWSDynamoDB/01234567890123-abcdef12/manifest-summary.json', itemCount: 1 })
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
      const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      const chunks: Buffer[] = []
      for await (const bytes of encryptBackupStream(source.open(new AbortController().signal), publicKey, 1024 * 1024)) chunks.push(bytes)
      const encrypted = Buffer.concat(chunks)
      expect(encrypted.includes(Buffer.from(tableArn))).toBe(false)
      const end = 12 + encrypted.readUInt32BE(8)
      const header = JSON.parse(encrypted.subarray(12, end).toString())
      const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(header.wrappedKey, 'base64'))
      const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
      cipher.setAAD(encrypted.subarray(0, end)); cipher.setAuthTag(encrypted.subarray(-16))
      const schema = JSON.parse(Buffer.concat([cipher.update(encrypted.subarray(end, -16)), cipher.final()]).toString())
      await local.send(new CreateTableCommand(schema.createTable)); created = true
      await waitUntilTableExists({ client: local, maxWaitTime: 10, minDelay: 1, maxDelay: 2 }, { TableName: tableName })
      const item = { id: { S: 'restored-row' }, category: { S: 'backup' } }
      await local.send(new PutItemCommand({ TableName: tableName, Item: item }))
      const base = await local.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: 'id = :id', ExpressionAttributeValues: { ':id': item.id }, ConsistentRead: true }))
      expect(base.Items).toEqual([item])
      const index = await local.send(new QueryCommand({ TableName: tableName, IndexName: 'category-index', KeyConditionExpression: 'category = :category', ExpressionAttributeValues: { ':category': item.category } }))
      expect(index.Items).toEqual([item])
    } finally {
      try { if (created) await local.send(new DeleteTableCommand({ TableName: tableName })) }
      finally { aws.restore(); observed.destroy(); local.destroy() }
    }
  })
})
