import { inspectBackup, type BackupInspectionRequest } from '../../src/backup/backup-inspector'

const request: BackupInspectionRequest = {
  awsAccountId: '123456789012', region: 'ap-northeast-1', planName: 'tenant-project-policy',
  vaults: [{ name: 'vault', minRetentionDays: 7, maxRetentionDays: 30 }],
  selectionNames: ['selection'], resourceTypes: ['DynamoDB'], lookbackHours: 24,
}

function client() {
  return {
    accountId: jest.fn().mockResolvedValue('123456789012'),
    describeVault: jest.fn().mockResolvedValue({ Locked: true, LockDate: new Date('2026-01-01'), MinRetentionDays: 7, MaxRetentionDays: 30 }),
    listPlans: jest.fn().mockResolvedValue({ BackupPlansList: [{ BackupPlanName: request.planName, BackupPlanId: 'plan' }] }),
    getPlan: jest.fn().mockResolvedValue({ BackupPlan: { BackupPlanName: request.planName } }),
    listSelections: jest.fn().mockResolvedValue({ BackupSelectionsList: [{ SelectionName: 'selection', SelectionId: 's1' }] }),
    getSelection: jest.fn().mockResolvedValue({ BackupSelection: { SelectionName: 'selection' } }),
    listRecoveryPoints: jest.fn().mockResolvedValue({ RecoveryPoints: [{ ResourceArn: 'resource1', Status: 'COMPLETED', CreatedBy: { BackupPlanId: 'plan' } }] }),
    listJobs: jest.fn().mockResolvedValue({ BackupJobs: [{ BackupJobId: 'job1', State: 'COMPLETED', MessageCategory: 'SUCCESS', CreatedBy: { BackupPlanId: 'plan' } }] }),
    regionSettings: jest.fn().mockResolvedValue({ ResourceTypeOptInPreference: { DynamoDB: true }, ResourceTypeManagementPreference: { DynamoDB: true } }),
  }
}

describe('backup inspection', () => {
  it('stops before reading Backup when the host account does not match', async () => {
    const aws = client()
    aws.accountId.mockResolvedValue('999999999999')
    await expect(inspectBackup(request, aws)).rejects.toThrow('AWS_ACCOUNT_MISMATCH')
    expect(aws.describeVault).not.toHaveBeenCalled()
    expect(aws.listPlans).not.toHaveBeenCalled()
  })

  it('collects policy-scoped protection and successful jobs', async () => {
    const result = await inspectBackup(request, client())
    expect(result.issues).toEqual([])
    expect(result.protectedResourceCount).toBe(1)
    expect(result.jobs).toEqual({ COMPLETED: 1 })
  })

  it('paginates, excludes other plans, and reports completed-with-issues', async () => {
    const aws = client()
    aws.listJobs.mockResolvedValueOnce({ BackupJobs: [{ State: 'FAILED', CreatedBy: { BackupPlanId: 'other' } }], NextToken: 'next' })
      .mockResolvedValueOnce({ BackupJobs: [{ State: 'COMPLETED', MessageCategory: 'AccessDenied', CreatedBy: { BackupPlanId: 'plan' } }] })
    const result = await inspectBackup(request, aws)
    expect(result.jobs).toEqual({ COMPLETED_WITH_ISSUES: 1 })
    expect(result.issues).toContain('JOBS_UNHEALTHY')
    expect(aws.listJobs.mock.calls[1][2]).toBe('next')
  })

  it('rejects governance-only locks and reports grace periods', async () => {
    const aws = client()
    aws.describeVault.mockResolvedValueOnce({ Locked: true, MinRetentionDays: 7, MaxRetentionDays: 30 })
    expect((await inspectBackup(request, aws)).issues).toContain('VAULT_COMPLIANCE_MISSING:vault')
    aws.describeVault.mockResolvedValueOnce({ Locked: true, LockDate: new Date('2099-01-01'), MinRetentionDays: 7, MaxRetentionDays: 30 })
    expect((await inspectBackup(request, aws)).issues).toContain('VAULT_GRACE_PERIOD:vault')
  })

  it('reports missing plans instead of inventing a healthy empty result', async () => {
    const aws = client()
    aws.listPlans.mockResolvedValue({ BackupPlansList: [] })
    const result = await inspectBackup(request, aws)
    expect(result.issues).toContain('PLAN_MISSING')
    expect(result.protectedResourceCount).toBe(0)
    expect(aws.listJobs).not.toHaveBeenCalled()
  })

  it('reports missing selections, retention drift, and disabled region settings', async () => {
    const aws = client()
    aws.describeVault.mockResolvedValue({ Locked: true, LockDate: new Date('2026-01-01'), MinRetentionDays: 1, MaxRetentionDays: 30 })
    aws.listSelections.mockResolvedValue({ BackupSelectionsList: [] })
    aws.regionSettings.mockResolvedValue({ ResourceTypeOptInPreference: {}, ResourceTypeManagementPreference: {} })
    const result = await inspectBackup(request, aws)
    expect(result.issues).toEqual(expect.arrayContaining(['VAULT_RETENTION_DRIFT:vault', 'SELECTION_MISSING:selection', 'REGION_NOT_OPTED_IN:DynamoDB', 'DYNAMODB_ADVANCED_DISABLED']))
  })

  it('fails on repeated pagination tokens and AWS errors rather than returning partial success', async () => {
    const aws = client()
    aws.listPlans.mockResolvedValue({ BackupPlansList: [], NextToken: 'loop' })
    await expect(inspectBackup(request, aws)).rejects.toThrow('PAGINATION_LIMIT')
    aws.listPlans.mockRejectedValue(new Error('AccessDenied'))
    await expect(inspectBackup(request, aws)).rejects.toThrow('AccessDenied')
  })

  it('does not count incomplete or deleted recovery points as protection', async () => {
    const aws = client()
    aws.listRecoveryPoints.mockResolvedValue({ RecoveryPoints: [
      { ResourceArn: 'bad', Status: 'PARTIAL', CreatedBy: { BackupPlanId: 'plan' } },
      { ResourceArn: 'expired', Status: 'EXPIRED', CreatedBy: { BackupPlanId: 'plan' } },
    ] })
    const result = await inspectBackup(request, aws)
    expect(result.protectedResourceCount).toBe(0)
    expect(result.issues).toContain('NO_PROTECTED_RESOURCES')
  })

  it('uses MessageCategory to distinguish completion and treats unknown states as unhealthy', async () => {
    const aws = client()
    aws.listJobs.mockResolvedValue({ BackupJobs: [
      { State: 'COMPLETED', MessageCategory: 'SUCCESS', StatusMessage: 'Finished', CreatedBy: { BackupPlanId: 'plan' } },
      { State: '__proto__', CreatedBy: { BackupPlanId: 'plan' } },
    ] })
    const result = await inspectBackup(request, aws)
    expect(result.jobs).toEqual({ COMPLETED: 1, UNKNOWN: 1 })
    expect(result.issues).toContain('JOBS_UNHEALTHY')
  })

  it('reports a missing vault and empty backup history', async () => {
    const aws = client()
    aws.describeVault.mockRejectedValue(Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' }))
    const result = await inspectBackup(request, aws)
    expect(result.issues).toEqual(expect.arrayContaining(['VAULT_MISSING:vault', 'NO_PROTECTED_RESOURCES', 'NO_RECENT_JOBS']))
    expect(aws.listRecoveryPoints).not.toHaveBeenCalled()
  })
})
