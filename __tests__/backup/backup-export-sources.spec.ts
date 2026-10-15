import { enumerateBackupExportSources } from '../../src/backup/backup-export-sources'
import { loadBackupDatabaseConnection } from '../../src/backup/backup-source-secrets'
import { streamDatabaseDump } from '../../src/backup/backup-database-dump'
import { listBackupS3Objects, streamBackupS3Object } from '../../src/backup/backup-s3-source'
import { startDynamoBackupExport } from '../../src/backup/backup-dynamodb-export'
import { captureDynamoBackupSchema } from '../../src/backup/backup-dynamodb-schema'
import { enumerateDynamoBackupSources } from '../../src/backup/backup-dynamodb-source'

jest.mock('../../src/backup/backup-source-secrets')
jest.mock('../../src/backup/backup-database-dump')
jest.mock('../../src/backup/backup-s3-source')
jest.mock('../../src/backup/backup-dynamodb-export')
jest.mock('../../src/backup/backup-dynamodb-schema')
jest.mock('../../src/backup/backup-dynamodb-source')
const context = { accountId: '123456789012', region: 'ap-northeast-1' }
const bucket = { type: 's3' as const, arn: 'arn:aws:s3:::private-source', bucket: 'private-source' }
const db = { type: 'rds' as const, arn: 'arn:aws:rds:ap-northeast-1:123456789012:db:source', database: { resourceArn: 'arn:aws:rds:ap-northeast-1:123456789012:db:source', engine: 'postgres', host: 'host', port: 5432 } }
const table = { type: 'dynamodb' as const, arn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/source' }
const clients = { s3: jest.fn(() => ({} as any)), dynamodb: jest.fn(() => ({} as any)) }
const limits = { runId: 'run-1', exportTime: new Date('2026-01-01'), maxObjects: 100, maxObjectBytes: 100000, timeoutMs: 10000 }
const signal = new AbortController().signal
async function collect(input: AsyncIterable<any>) { const out = []; for await (const item of input) out.push(item); return out }
async function bytes(input: AsyncIterable<Uint8Array>) { return Buffer.concat(await collect(input)).toString() }
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(listBackupS3Objects).mockImplementation(async function* () {})
})
it('records an empty selected bucket without serializing secrets or endpoints', async () => {
  const items = await collect(enumerateBackupExportSources(context, [bucket], { version: 1, databases: [] }, clients, limits, signal))
  expect(items).toHaveLength(1)
  expect(items[0].format).toBe('resource-inventory')
  expect(JSON.parse(await bytes(items[0].open(signal)))).toEqual({ version: 1, resources: [{ type: 's3', arn: bucket.arn }] })
})
it('validates every DB mapping before yielding any source or making source calls', async () => {
  const iterator = enumerateBackupExportSources(context, [bucket, db], { version: 1, databases: [] }, clients, limits, signal)
  await expect(iterator.next()).rejects.toThrow('BACKUP_SOURCE_MAPPING_REQUIRED')
  expect(listBackupS3Objects).not.toHaveBeenCalled()
  expect(loadBackupDatabaseConnection).not.toHaveBeenCalled()
})
it('requires staging for DynamoDB before yielding anything', async () => {
  await expect(enumerateBackupExportSources(context, [bucket, table], { version: 1, databases: [] }, clients, limits, signal).next()).rejects.toThrow('BACKUP_DYNAMODB_STAGING_REQUIRED')
})
it('opens database secrets lazily and passes the active cancellation signal to dumping', async () => {
  const mapping = { resourceArn: db.arn, name: 'app', credentialSecretArn: 'secret', caSecretArn: 'ca' }
  const connection = { engine: 'postgres' as const, host: 'host', port: 5432, database: 'app', username: 'user', password: 'private', caPem: 'ca' }
  jest.mocked(loadBackupDatabaseConnection).mockResolvedValue(connection)
  jest.mocked(streamDatabaseDump).mockImplementation(async function* () { yield Buffer.from('dump') })
  const items = await collect(enumerateBackupExportSources(context, [db], { version: 1, databases: [mapping] }, clients, limits, signal))
  expect(loadBackupDatabaseConnection).not.toHaveBeenCalled()
  expect(items[1]).toMatchObject({ name: 'app', format: 'postgres-custom' })
  expect(await bytes(items[1].open(signal))).toBe('dump')
  expect(streamDatabaseDump).toHaveBeenCalledWith(connection, { maxBytes: limits.maxObjectBytes, timeoutMs: limits.timeoutMs, signal })
  expect(await bytes(items[0].open(signal))).not.toContain('host')
})
it('streams S3 objects with the listed identity and active signal', async () => {
  const object = { bucket: bucket.bucket, accountId: context.accountId, key: 'resource-inventory.json', bytes: 3, etag: 'etag' }
  jest.mocked(listBackupS3Objects).mockImplementation(async function* () { yield object })
  jest.mocked(streamBackupS3Object).mockImplementation(async function* () { yield Buffer.from('s3') })
  const items = await collect(enumerateBackupExportSources(context, [bucket], { version: 1, databases: [] }, clients, limits, signal))
  expect(await bytes(items[1].open(signal))).toBe('s3')
  expect(streamBackupS3Object).toHaveBeenCalledWith(expect.anything(), object, signal)
})
it('includes the DynamoDB schema and exported files using the fixed snapshot time', async () => {
  const completed = { tableArn: table.arn } as any
  const schema = { format: 'dynamodb-schema' } as any
  jest.mocked(startDynamoBackupExport).mockResolvedValue(completed)
  jest.mocked(captureDynamoBackupSchema).mockResolvedValue(schema)
  jest.mocked(enumerateDynamoBackupSources).mockImplementation(async function* () { yield { format: 'dynamodb-json-gzip' } as any })
  const items = await collect(enumerateBackupExportSources(context, [table], { version: 1, databases: [], dynamodbStaging: { bucket: 'staging', prefix: 'exports' } }, clients, limits, signal))
  expect(items.map(x => x.format)).toEqual(['resource-inventory', 'dynamodb-schema', 'dynamodb-json-gzip'])
  expect(startDynamoBackupExport).toHaveBeenCalledWith(expect.anything(), expect.anything(), context, expect.objectContaining({ exportTime: limits.exportTime, runId: limits.runId }), signal)
})
it('refuses an aborted or empty selection', async () => {
  await expect(enumerateBackupExportSources(context, [], { version: 1, databases: [] }, clients, limits, signal).next()).rejects.toThrow('BACKUP_EXPORT_SELECTION_EMPTY')
  await expect(enumerateBackupExportSources(context, [bucket], { version: 1, databases: [] }, clients, limits, AbortSignal.abort()).next()).rejects.toThrow('BACKUP_EXPORT_ABORTED')
})
