import {
  BackupClient, DescribeBackupVaultCommand, DescribeRegionSettingsCommand,
  GetBackupPlanCommand, GetBackupSelectionCommand, ListBackupJobsCommand,
  ListBackupPlansCommand, ListBackupSelectionsCommand, ListRecoveryPointsByBackupVaultCommand,
} from '@aws-sdk/client-backup'
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts'
import { mockClient } from 'aws-sdk-client-mock'
import { createBackupInspectionClient } from '../../src/backup/backup-aws-client'

const credentials = jest.fn()
jest.mock('@aws-sdk/credential-providers', () => ({ fromNodeProviderChain: jest.fn(() => credentials) }))

describe('environment-only backup AWS client', () => {
  const backup = mockClient(BackupClient)
  const sts = mockClient(STSClient)
  beforeEach(() => { backup.reset(); sts.reset(); credentials.mockReset() })
  afterAll(() => { backup.restore(); sts.restore() })

  it('uses the host provider for both clients and destroys them on close', async () => {
    sts.on(GetCallerIdentityCommand).resolves({ Account: '123456789012' })
    backup.on(DescribeBackupVaultCommand).resolves({ Locked: true })
    const destroyBackup = jest.spyOn(BackupClient.prototype, 'destroy')
    const destroySts = jest.spyOn(STSClient.prototype, 'destroy')
    const aws = createBackupInspectionClient('ap-northeast-1')
    try {
      expect(await aws.accountId()).toBe('123456789012')
      expect(await aws.describeVault('vault')).toEqual({ Locked: true })
      await expect(backup.call(0).thisValue.config.region()).resolves.toBe('ap-northeast-1')
      credentials.mockResolvedValue({ accessKeyId: 'host-key', secretAccessKey: 'host-secret' })
      await sts.call(0).thisValue.config.credentials()
      await backup.call(0).thisValue.config.credentials()
      expect(credentials).toHaveBeenCalledTimes(2)
    } finally { aws.close() }
    expect(destroyBackup).toHaveBeenCalledTimes(1)
    expect(destroySts).toHaveBeenCalledTimes(1)
    destroyBackup.mockRestore(); destroySts.mockRestore()
  })

  it('passes the vault, creation window and pagination token to AWS', async () => {
    backup.on(ListBackupJobsCommand).resolves({ BackupJobs: [], NextToken: 'next' })
    const aws = createBackupInspectionClient('ap-northeast-1')
    const after = new Date('2026-10-01')
    try {
      expect(await aws.listJobs('vault', after, 'page')).toEqual({ BackupJobs: [], NextToken: 'next' })
      expect(backup.commandCalls(ListBackupJobsCommand)[0].args[0].input).toEqual({ ByBackupVaultName: 'vault', ByCreatedAfter: after, NextToken: 'page', MaxResults: 1000 })
    } finally { aws.close() }
  })

  it('preserves pagination and resource scope through the SDK inspection boundary', async () => {
    backup.on(ListBackupPlansCommand).resolves({ BackupPlansList: [{ BackupPlanId: 'plan' }], NextToken: 'plans-next' })
    backup.on(GetBackupPlanCommand).resolves({ BackupPlan: { BackupPlanName: 'expected-plan', Rules: [] } })
    backup.on(ListBackupSelectionsCommand).resolves({ BackupSelectionsList: [{ SelectionId: 'selection' }], NextToken: 'selections-next' })
    backup.on(GetBackupSelectionCommand).resolves({ BackupSelection: { SelectionName: 'expected-selection', IamRoleArn: 'arn:aws:iam::123456789012:role/backup', Resources: ['arn:aws:ec2:ap-northeast-1:123456789012:instance/i-12345678'] } })
    backup.on(ListRecoveryPointsByBackupVaultCommand).resolves({ RecoveryPoints: [{ Status: 'COMPLETED' }], NextToken: 'points-next' })
    backup.on(DescribeRegionSettingsCommand).resolves({ ResourceTypeOptInPreference: { DynamoDB: true }, ResourceTypeManagementPreference: { DynamoDB: true } })
    const aws = createBackupInspectionClient('ap-northeast-1')
    try {
      expect(await aws.listPlans('plans-page')).toMatchObject({ NextToken: 'plans-next' })
      expect(await aws.getPlan('plan')).toMatchObject({ BackupPlan: { BackupPlanName: 'expected-plan' } })
      expect(await aws.listSelections('plan', 'selections-page')).toMatchObject({ NextToken: 'selections-next' })
      expect(await aws.getSelection('plan', 'selection')).toMatchObject({ BackupSelection: { SelectionName: 'expected-selection' } })
      expect(await aws.listRecoveryPoints('vault', 'points-page')).toMatchObject({ NextToken: 'points-next' })
      expect(await aws.regionSettings()).toEqual({ ResourceTypeOptInPreference: { DynamoDB: true }, ResourceTypeManagementPreference: { DynamoDB: true } })
      expect(backup.commandCalls(ListBackupPlansCommand)[0].args[0].input).toEqual({ NextToken: 'plans-page', MaxResults: 1000 })
      expect(backup.commandCalls(GetBackupPlanCommand)[0].args[0].input).toEqual({ BackupPlanId: 'plan' })
      expect(backup.commandCalls(ListBackupSelectionsCommand)[0].args[0].input).toEqual({ BackupPlanId: 'plan', NextToken: 'selections-page', MaxResults: 1000 })
      expect(backup.commandCalls(GetBackupSelectionCommand)[0].args[0].input).toEqual({ BackupPlanId: 'plan', SelectionId: 'selection' })
      expect(backup.commandCalls(ListRecoveryPointsByBackupVaultCommand)[0].args[0].input).toEqual({ BackupVaultName: 'vault', NextToken: 'points-page', MaxResults: 1000 })
      for (const call of backup.calls()) {
        expect(call.args[1]?.abortSignal).toBeInstanceOf(AbortSignal)
        expect(call.thisValue.config.ignoreConfiguredEndpointUrls).toBe(true)
      }
    } finally { aws.close() }
  })
})
