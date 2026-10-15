import {
  BackupClient, DescribeBackupVaultCommand, DescribeRegionSettingsCommand,
  GetBackupPlanCommand, GetBackupSelectionCommand, ListBackupJobsCommand,
  ListBackupPlansCommand, ListBackupSelectionsCommand, ListRecoveryPointsByBackupVaultCommand,
} from '@aws-sdk/client-backup'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts'

import type { BackupInspectionClient } from './backup-inspector'

/** Tenant-owned AWS context only; never accepts credentials from a command. */
export function createBackupInspectionClient(region: string): BackupInspectionClient & { close(): void } {
  const credentials = fromNodeProviderChain()
  const config = {
    region, credentials, maxAttempts: 2,
    // Ignore custom service endpoint environment variables: STS identity and
    // Backup must be checked against AWS, not a local endpoint returning success.
    ignoreConfiguredEndpointUrls: true,
    requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
  }
  const sts = new STSClient(config)
  const backup = new BackupClient(config)
  const options = { abortSignal: AbortSignal.timeout(120000) }
  return {
    accountId: async () => (await sts.send(new GetCallerIdentityCommand({}), options)).Account,
    describeVault: (name) => backup.send(new DescribeBackupVaultCommand({ BackupVaultName: name }), options),
    listPlans: (NextToken) => backup.send(new ListBackupPlansCommand({ NextToken, MaxResults: 1000 }), options),
    getPlan: (BackupPlanId) => backup.send(new GetBackupPlanCommand({ BackupPlanId }), options),
    listSelections: (BackupPlanId, NextToken) => backup.send(new ListBackupSelectionsCommand({ BackupPlanId, NextToken, MaxResults: 1000 }), options),
    getSelection: (BackupPlanId, SelectionId) => backup.send(new GetBackupSelectionCommand({ BackupPlanId, SelectionId }), options),
    listRecoveryPoints: (BackupVaultName, NextToken) => backup.send(new ListRecoveryPointsByBackupVaultCommand({ BackupVaultName, NextToken, MaxResults: 1000 }), options),
    listJobs: (ByBackupVaultName, ByCreatedAfter, NextToken) => backup.send(new ListBackupJobsCommand({ ByBackupVaultName, ByCreatedAfter, NextToken, MaxResults: 1000 }), options),
    regionSettings: () => backup.send(new DescribeRegionSettingsCommand({}), options),
    close: () => { sts.destroy(); backup.destroy() },
  }
}
