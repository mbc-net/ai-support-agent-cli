import { resolveBackupResources, type BackupResourceSelectionClient, type BackupResourceTarget } from '../../src/backup/backup-resource-selection'

const context = { accountId: '123456789012', region: 'ap-northeast-1' }
const dbArn = 'arn:aws:rds:ap-northeast-1:123456789012:db:app'
const target = (): BackupResourceTarget => ({ type: 'rds', selector: { mode: 'arn', arns: [dbArn] } })
const client = (): jest.Mocked<BackupResourceSelectionClient> => ({ accountId: jest.fn().mockResolvedValue(context.accountId), listTagged: jest.fn(), describe: jest.fn().mockImplementation(async (type, arn) => ({ type, arn })) })

describe('backup export resource selection', () => {
  it('resolves exact ARNs and deduplicates overlapping selectors', async () => {
    const aws = client()
    const result = await resolveBackupResources(context, [target(), target()], aws)
    expect(result.resources).toEqual([{ type: 'rds', arn: dbArn }])
    expect(aws.describe).toHaveBeenCalledTimes(1)
  })
  it('accepts the policy API limit of 500 explicit ARNs per target', async () => {
    const arns = Array.from({ length: 500 }, (_, index) => `${dbArn}-${index}`)
    const result = await resolveBackupResources(context, [{ type: 'rds', selector: { mode: 'arn', arns } }], client())
    expect(result.resources).toHaveLength(500)
  })
  it('checks STS before resolving tags or resource metadata', async () => {
    const aws = client(); aws.accountId.mockResolvedValue('999999999999')
    await expect(resolveBackupResources(context, [target()], aws)).rejects.toThrow('BACKUP_AWS_ACCOUNT_MISMATCH')
    expect(aws.describe).not.toHaveBeenCalled(); expect(aws.listTagged).not.toHaveBeenCalled()
  })
  it.each([
    dbArn.replace('123456789012', '999999999999'), dbArn.replace('ap-northeast-1', 'us-east-1'), dbArn + '*', dbArn.replace('arn:aws:', 'arn:aws-cn:'),
  ])('rejects out-of-scope ARNs before contacting AWS (%#)', async (arn) => {
    const aws = client()
    await expect(resolveBackupResources(context, [{ type: 'rds', selector: { mode: 'arn', arns: [arn] } }], aws)).rejects.toThrow('BACKUP_EXPORT_INVALID_SELECTION')
    expect(aws.accountId).not.toHaveBeenCalled()
  })
  it('walks tagged resources to the final page and checks the returned tag value', async () => {
    const aws = client()
    aws.listTagged.mockResolvedValueOnce({ resources: [{ arn: dbArn, tags: { Backup: 'daily' } }], nextToken: 'next' }).mockResolvedValueOnce({ resources: [{ arn: dbArn + '-2', tags: { Backup: 'daily' } }] })
    const result = await resolveBackupResources(context, [{ type: 'rds', selector: { mode: 'tag', tagKey: 'Backup', tagValue: 'daily' } }], aws)
    expect(result.resources.map((r) => r.arn)).toEqual([dbArn, dbArn + '-2'])
    expect(aws.listTagged).toHaveBeenLastCalledWith('rds', 'Backup', 'daily', 'next')
  })
  it('fails on a tag query with no matching resources', async () => {
    const aws = client(); aws.listTagged.mockResolvedValue({ resources: [] })
    await expect(resolveBackupResources(context, [{ type: 'rds', selector: { mode: 'tag', tagKey: 'Backup', tagValue: 'daily' } }], aws)).rejects.toThrow('BACKUP_EXPORT_SELECTION_EMPTY')
  })
  it('does not accept stale or mismatched tag results', async () => {
    const aws = client(); aws.listTagged.mockResolvedValue({ resources: [{ arn: dbArn, tags: { Backup: 'never' } }] })
    await expect(resolveBackupResources(context, [{ type: 'rds', selector: { mode: 'tag', tagKey: 'Backup', tagValue: 'daily' } }], aws)).rejects.toThrow('BACKUP_EXPORT_SELECTION_CHANGED')
  })
  it('rejects pagination loops instead of exporting a partial selection', async () => {
    const aws = client(); aws.listTagged.mockResolvedValue({ resources: [], nextToken: 'loop' })
    await expect(resolveBackupResources(context, [{ type: 's3', selector: { mode: 'tag', tagKey: 'Backup', tagValue: 'daily' } }], aws)).rejects.toThrow('BACKUP_EXPORT_PAGINATION_FAILED')
  })
  it('keeps native-only types explicit and refuses a purely native export', async () => {
    const native: BackupResourceTarget = { type: 'ec2', selector: { mode: 'tag', tagKey: 'Backup', tagValue: 'daily' } }
    expect((await resolveBackupResources(context, [target(), native], client())).nativeOnlyTypes).toEqual(['ec2'])
    await expect(resolveBackupResources(context, [native], client())).rejects.toThrow('BACKUP_EXPORT_NO_LOGICAL_TARGETS')
  })
  it('does not accept a Describe response for another resource', async () => {
    const aws = client(); aws.describe.mockResolvedValue({ type: 'rds', arn: dbArn + '-other' })
    await expect(resolveBackupResources(context, [target()], aws)).rejects.toThrow('BACKUP_EXPORT_SELECTION_CHANGED')
  })
  it('sanitizes provider failures and stops before later resources', async () => {
    const aws = client(); aws.describe.mockRejectedValue(new Error('credential process stderr'))
    await expect(resolveBackupResources(context, [target()], aws)).rejects.toThrow(/^BACKUP_EXPORT_SELECTION_FAILED$/)
  })
})
