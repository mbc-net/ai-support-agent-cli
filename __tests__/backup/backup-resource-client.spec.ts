import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } from '@aws-sdk/client-rds'
import { S3Client, HeadBucketCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3'
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { mockClient } from 'aws-sdk-client-mock'
import { createBackupResourceClient } from '../../src/backup/backup-resource-client'

jest.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: jest.fn(() => async () => ({ accessKeyId: 'host', secretAccessKey: 'host' })) }))
const context = { accountId: '123456789012', region: 'ap-northeast-1' }
const dbArn = 'arn:aws:rds:ap-northeast-1:123456789012:db:app'
describe('backup resource AWS adapter', () => {
  const sts = mockClient(STSClient); const rds = mockClient(RDSClient); const s3 = mockClient(S3Client)
  const tags = mockClient(ResourceGroupsTaggingAPIClient); const dynamodb = mockClient(DynamoDBClient)
  beforeEach(() => { for (const mock of [sts, rds, s3, tags, dynamodb]) mock.reset(); sts.on(GetCallerIdentityCommand).resolves({ Account: context.accountId }) })
  afterAll(() => { for (const mock of [sts, rds, s3, tags, dynamodb]) mock.restore() })
  it('does not expose resource operations until STS has matched', async () => {
    const client = createBackupResourceClient(context)
    try {
      await expect(client.describe('rds', dbArn)).rejects.toThrow('BACKUP_AWS_ACCOUNT_NOT_VERIFIED')
      expect(() => client.s3()).toThrow('BACKUP_AWS_ACCOUNT_NOT_VERIFIED')
      expect(rds.calls()).toHaveLength(0)
      sts.on(GetCallerIdentityCommand).resolves({ Account: '999999999999' })
      await client.accountId()
      await expect(client.listTagged('rds', 'Backup', 'daily')).rejects.toThrow('BACKUP_AWS_ACCOUNT_NOT_VERIFIED')
      expect(tags.calls()).toHaveLength(0)
    } finally { client.close() }
  })
  it('obtains the RDS writer endpoint from the matching Describe response', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{ DBInstanceArn: dbArn, Engine: 'postgres', DBInstanceStatus: 'available', Endpoint: { Address: 'app.abc.ap-northeast-1.rds.amazonaws.com', Port: 5432 } }] })
    const client = createBackupResourceClient(context)
    try {
      await client.accountId()
      expect(await client.describe('rds', dbArn)).toMatchObject({ type: 'rds', arn: dbArn, database: { resourceArn: dbArn, engine: 'postgres', port: 5432 } })
      expect(rds.commandCalls(DescribeDBInstancesCommand)[0].args[0].input).toEqual({ DBInstanceIdentifier: dbArn })
    } finally { client.close() }
  })
  it('rejects a different cluster ARN in Describe', async () => {
    rds.on(DescribeDBClustersCommand).resolves({ DBClusters: [{ DBClusterArn: dbArn.replace(':db:', ':cluster:') + '-other', Engine: 'aurora-mysql', Status: 'available', Endpoint: 'db.example', Port: 3306 }] })
    const client = createBackupResourceClient(context)
    try { await client.accountId(); await expect(client.describe('aurora', dbArn.replace(':db:', ':cluster:'))).rejects.toThrow('BACKUP_EXPORT_SELECTION_CHANGED') } finally { client.close() }
  })
  it('rejects RDS engines that cannot be exported by the supported dump tools', async () => {
    rds.on(DescribeDBInstancesCommand).resolves({ DBInstances: [{ DBInstanceArn: dbArn, Engine: 'oracle-ee', DBInstanceStatus: 'available', Endpoint: { Address: 'db.example', Port: 1521 } }] })
    const client = createBackupResourceClient(context)
    try { await client.accountId(); await expect(client.describe('rds', dbArn)).rejects.toThrow('BACKUP_EXPORT_ENGINE_UNSUPPORTED') } finally { client.close() }
  })
  it('checks both bucket owner and region', async () => {
    s3.on(HeadBucketCommand).resolves({}); s3.on(GetBucketLocationCommand).resolves({ LocationConstraint: 'ap-northeast-1' })
    const client = createBackupResourceClient(context)
    try {
      await client.accountId()
      expect(await client.describe('s3', 'arn:aws:s3:::tenant-source')).toEqual({ type: 's3', arn: 'arn:aws:s3:::tenant-source', bucket: 'tenant-source' })
      expect(s3.commandCalls(HeadBucketCommand)[0].args[0].input.ExpectedBucketOwner).toBe(context.accountId)
      expect(s3.commandCalls(GetBucketLocationCommand)[0].args[0].input.ExpectedBucketOwner).toBe(context.accountId)
      s3.on(GetBucketLocationCommand).resolves({ LocationConstraint: 'us-west-2' })
      await expect(client.describe('s3', 'arn:aws:s3:::tenant-source')).rejects.toThrow('BACKUP_EXPORT_SELECTION_CHANGED')
    } finally { client.close() }
  })
  it('uses scoped tag filters and returns pagination', async () => {
    tags.on(GetResourcesCommand).resolves({ ResourceTagMappingList: [{ ResourceARN: dbArn, Tags: [{ Key: 'Backup', Value: 'daily' }] }], PaginationToken: 'next' })
    const client = createBackupResourceClient(context)
    try {
      await client.accountId()
      expect(await client.listTagged('rds', 'Backup', 'daily')).toEqual({ resources: [{ arn: dbArn, tags: { Backup: 'daily' } }], nextToken: 'next' })
      expect(tags.commandCalls(GetResourcesCommand)[0].args[0].input).toMatchObject({ ResourceTypeFilters: ['rds:db'], TagFilters: [{ Key: 'Backup', Values: ['daily'] }] })
    } finally { client.close() }
  })
  it('checks the DynamoDB table ARN and status', async () => {
    const arn = 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/app'
    dynamodb.on(DescribeTableCommand).resolves({ Table: { TableArn: arn, TableName: 'app', TableStatus: 'ACTIVE' } })
    const client = createBackupResourceClient(context)
    try {
      await client.accountId()
      expect(await client.describe('dynamodb', arn)).toEqual({ type: 'dynamodb', arn, tableName: 'app' })
      expect(dynamodb.commandCalls(DescribeTableCommand)[0].args[0].input).toEqual({ TableName: arn })
    } finally { client.close() }
  })
})
