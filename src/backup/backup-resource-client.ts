import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } from '@aws-sdk/client-rds'
import { S3Client, HeadBucketCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3'
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb'
import { ResourceGroupsTaggingAPIClient, GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { isScopedBackupResourceArn, type BackupResourceSelectionClient } from './backup-resource-selection'
import type { BackupTenantContext } from './backup-source-secrets'

/** Host credential chain only; custom AWS endpoint overrides are deliberately ignored. */
export function createBackupResourceClient(expected: BackupTenantContext, signal?: AbortSignal): BackupResourceSelectionClient & {
  s3(): S3Client
  dynamodb(): DynamoDBClient
  close(): void
} {
  const context = { ...expected }
  if (!/^\d{12}$/.test(context.accountId) || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(context.region)) throw new Error('BACKUP_EXPORT_INVALID_SELECTION')
  const config = {
    region: context.region, credentials: fromNodeProviderChain(), ignoreConfiguredEndpointUrls: true,
    maxAttempts: 2, requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
  }
  const sts = new STSClient(config); const rds = new RDSClient(config); const tags = new ResourceGroupsTaggingAPIClient(config)
  const s3 = new S3Client({ ...config, followRegionRedirects: false }); const dynamodb = new DynamoDBClient(config)
  const options = { abortSignal: signal ?? AbortSignal.timeout(120000) }
  let verified = false; let closed = false
  const check = (): void => {
    if (closed) throw new Error('BACKUP_AWS_CLIENT_CLOSED')
    if (options.abortSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
    if (!verified) throw new Error('BACKUP_AWS_ACCOUNT_NOT_VERIFIED')
  }
  return {
    accountId: async () => {
      verified = false
      if (closed) throw new Error('BACKUP_AWS_CLIENT_CLOSED')
      if (options.abortSignal.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
      const identity = await sts.send(new GetCallerIdentityCommand({}), options)
      verified = identity.Account === context.accountId && !closed && !options.abortSignal.aborted
      return identity.Account
    },
    listTagged: async (type, key, value, token) => {
      check()
      const filters = { rds: 'rds:db', aurora: 'rds:cluster', dynamodb: 'dynamodb:table', s3: 's3:bucket' }
      const result = await tags.send(new GetResourcesCommand({ ResourceTypeFilters: [filters[type]], TagFilters: [{ Key: key, Values: [value] }], ResourcesPerPage: 100, PaginationToken: token }), options)
      check()
      return {
        resources: (result.ResourceTagMappingList ?? []).map((resource) => {
          if (!resource.ResourceARN || !isScopedBackupResourceArn(resource.ResourceARN, type, context)) throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
          const values: Record<string, string> = Object.create(null)
          for (const tag of resource.Tags ?? []) {
            if (tag.Key === undefined || tag.Value === undefined || Object.hasOwn(values, tag.Key)) throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
            values[tag.Key] = tag.Value
          }
          return { arn: resource.ResourceARN, tags: values }
        }),
        nextToken: result.PaginationToken || undefined,
      }
    },
    describe: async (type, arn) => {
      check()
      if (!isScopedBackupResourceArn(arn, type, context)) throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
      if (type === 'rds' || type === 'aurora') {
        let engine: string | undefined; let host: string | undefined; let port: number | undefined
        if (type === 'rds') {
          const result = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: arn }), options)
          const db = result.DBInstances?.[0]
          if (result.DBInstances?.length !== 1 || !db || db.DBInstanceArn !== arn || db.DBInstanceStatus !== 'available') throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
          engine = db.Engine; host = db.Endpoint?.Address; port = db.Endpoint?.Port
          if (engine !== 'postgres' && engine !== 'mysql') throw new Error('BACKUP_EXPORT_ENGINE_UNSUPPORTED')
        } else {
          const result = await rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: arn }), options)
          const db = result.DBClusters?.[0]
          if (result.DBClusters?.length !== 1 || !db || db.DBClusterArn !== arn || db.Status !== 'available') throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
          engine = db.Engine; host = db.Endpoint; port = db.Port
          if (engine !== 'aurora-postgresql' && engine !== 'aurora-mysql') throw new Error('BACKUP_EXPORT_ENGINE_UNSUPPORTED')
        }
        check()
        if (!host || !Number.isInteger(port) || port! < 1 || port! > 65535) throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
        return { type, arn, database: { resourceArn: arn, engine, host, port: port! } }
      }
      if (type === 'dynamodb') {
        const result = await dynamodb.send(new DescribeTableCommand({ TableName: arn }), options)
        check()
        if (result.Table?.TableArn !== arn || result.Table.TableStatus !== 'ACTIVE' || result.Table.TableName !== arn.split('/')[1]) throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
        return { type, arn, tableName: result.Table.TableName }
      }
      const bucket = arn.slice(arn.indexOf(':::') + 3)
      await s3.send(new HeadBucketCommand({ Bucket: bucket, ExpectedBucketOwner: context.accountId }), options)
      const result = await s3.send(new GetBucketLocationCommand({ Bucket: bucket, ExpectedBucketOwner: context.accountId }), options)
      const region = result.LocationConstraint === 'EU' ? 'eu-west-1' : result.LocationConstraint || 'us-east-1'
      check()
      if (region !== context.region) throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
      return { type, arn, bucket }
    },
    s3: () => { check(); return s3 },
    dynamodb: () => { check(); return dynamodb },
    close: () => {
      closed = true; verified = false
      for (const client of [sts, rds, tags, s3, dynamodb]) client.destroy()
    },
  }
}
