/** Tenant-side inspection. This module never receives credentials or backup data. */
export interface BackupInspectionRequest {
  awsAccountId: string
  region: string
  planName: string
  vaults: { name: string; minRetentionDays: number; maxRetentionDays: number }[]
  selectionNames: string[]
  resourceTypes: string[]
  lookbackHours: number
}

type Page = { NextToken?: string }
type Plan = { BackupPlanName?: string; BackupPlanId?: string }
type Selection = { SelectionName?: string; SelectionId?: string }
type RecoveryPoint = { ResourceArn?: string; Status?: string; CreatedBy?: { BackupPlanId?: string } }
type Job = { State?: string; MessageCategory?: string; StatusMessage?: string; CreatedBy?: { BackupPlanId?: string } }

const JOB_STATES = new Set(['CREATED', 'PENDING', 'RUNNING', 'ABORTING', 'ABORTED', 'COMPLETED', 'FAILED', 'EXPIRED', 'PARTIAL'])

/** Narrow AWS adapter permits deterministic tests without a credential lookup. */
export interface BackupInspectionClient {
  accountId(): Promise<string | undefined>
  describeVault(name: string): Promise<{ Locked?: boolean; LockDate?: Date; MinRetentionDays?: number; MaxRetentionDays?: number }>
  listPlans(token?: string): Promise<Page & { BackupPlansList?: Plan[] }>
  getPlan(id: string): Promise<{ BackupPlan?: { BackupPlanName?: string } }>
  listSelections(planId: string, token?: string): Promise<Page & { BackupSelectionsList?: Selection[] }>
  getSelection(planId: string, selectionId: string): Promise<{ BackupSelection?: { SelectionName?: string } }>
  listRecoveryPoints(vault: string, token?: string): Promise<Page & { RecoveryPoints?: RecoveryPoint[] }>
  listJobs(vault: string, after: Date, token?: string): Promise<Page & { BackupJobs?: Job[] }>
  regionSettings(): Promise<{ ResourceTypeOptInPreference?: Record<string, boolean>; ResourceTypeManagementPreference?: Record<string, boolean> }>
}

export interface BackupInspectionResult {
  inspectedAt: string
  awsAccountId: string
  region: string
  issues: string[]
  protectedResourceCount: number
  jobs: Record<string, number>
}

async function pages<T extends Page>(read: (token?: string) => Promise<T>, consume: (page: T) => void): Promise<void> {
  const seen = new Set<string>()
  let token: string | undefined
  for (let page = 0; page < 1000; page++) {
    const result = await read(token)
    consume(result)
    token = result.NextToken
    if (!token) return
    if (seen.has(token)) throw new Error('BACKUP_PAGINATION_LIMIT')
    seen.add(token)
  }
  throw new Error('BACKUP_PAGINATION_LIMIT')
}

function missing(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException'
}

export async function inspectBackup(
  request: BackupInspectionRequest,
  aws: BackupInspectionClient,
  now = new Date(),
): Promise<BackupInspectionResult> {
  // Always before any Backup API call, including when the policy is malformed
  // or nothing has been provisioned yet. No API-issued credential fallback.
  const accountId = await aws.accountId()
  if (accountId !== request.awsAccountId) throw new Error('BACKUP_AWS_ACCOUNT_MISMATCH')
  const issues: string[] = []
  const result: BackupInspectionResult = {
    inspectedAt: now.toISOString(), awsAccountId: accountId,
    region: request.region, issues, protectedResourceCount: 0, jobs: {},
  }
  const existingVaults: string[] = []
  for (const expected of request.vaults) {
    try {
      const vault = await aws.describeVault(expected.name)
      existingVaults.push(expected.name)
      if (!vault.Locked || !vault.LockDate || !Number.isFinite(vault.LockDate.getTime())) {
        issues.push(`VAULT_COMPLIANCE_MISSING:${expected.name}`)
      } else if (vault.LockDate > now) {
        issues.push(`VAULT_GRACE_PERIOD:${expected.name}`)
      }
      if (vault.MinRetentionDays !== expected.minRetentionDays || vault.MaxRetentionDays !== expected.maxRetentionDays) {
        issues.push(`VAULT_RETENTION_DRIFT:${expected.name}`)
      }
    } catch (error) {
      if (!missing(error)) throw error
      issues.push(`VAULT_MISSING:${expected.name}`)
    }
  }

  const settings = await aws.regionSettings()
  for (const type of request.resourceTypes) {
    if (settings.ResourceTypeOptInPreference?.[type] !== true) issues.push(`REGION_NOT_OPTED_IN:${type}`)
  }
  if (request.resourceTypes.includes('DynamoDB') && settings.ResourceTypeManagementPreference?.DynamoDB !== true) {
    issues.push('DYNAMODB_ADVANCED_DISABLED')
  }

  const plans: Plan[] = []
  await pages((token) => aws.listPlans(token), (page) => {
    plans.push(...(page.BackupPlansList ?? []).filter((plan) => plan.BackupPlanName === request.planName))
  })
  if (plans.length !== 1 || !plans[0].BackupPlanId) {
    issues.push(plans.length === 0 ? 'PLAN_MISSING' : 'PLAN_AMBIGUOUS')
    return result
  }
  const planId = plans[0].BackupPlanId
  const plan = await aws.getPlan(planId)
  if (plan.BackupPlan?.BackupPlanName !== request.planName) throw new Error('BACKUP_PLAN_CHANGED')
  const selections: Selection[] = []
  await pages((token) => aws.listSelections(planId, token), (page) => selections.push(...(page.BackupSelectionsList ?? [])))
  for (const name of request.selectionNames) {
    const selected = selections.filter((selection) => selection.SelectionName === name)
    if (selected.length !== 1 || !selected[0].SelectionId) {
      issues.push(`SELECTION_MISSING:${name}`)
      continue
    }
    const selection = await aws.getSelection(planId, selected[0].SelectionId)
    if (selection.BackupSelection?.SelectionName !== name) issues.push(`SELECTION_MISSING:${name}`)
  }

  const resources = new Set<string>()
  const after = new Date(now.getTime() - request.lookbackHours * 3600000)
  for (const vault of existingVaults) {
    await pages((token) => aws.listRecoveryPoints(vault, token), (page) => {
      for (const point of page.RecoveryPoints ?? []) {
        if (point.CreatedBy?.BackupPlanId === planId && point.Status === 'COMPLETED' && point.ResourceArn) resources.add(point.ResourceArn)
      }
    })
    await pages((token) => aws.listJobs(vault, after, token), (page) => {
      for (const job of page.BackupJobs ?? []) {
        if (job.CreatedBy?.BackupPlanId !== planId) continue
        const state = job.State === 'COMPLETED' && job.MessageCategory !== 'SUCCESS'
          ? 'COMPLETED_WITH_ISSUES' : job.State && JOB_STATES.has(job.State) ? job.State : 'UNKNOWN'
        result.jobs[state] = (result.jobs[state] ?? 0) + 1
      }
    })
  }
  result.protectedResourceCount = resources.size
  if (!resources.size) issues.push('NO_PROTECTED_RESOURCES')
  if (!Object.keys(result.jobs).length) issues.push('NO_RECENT_JOBS')
  if (['FAILED', 'EXPIRED', 'ABORTED', 'PARTIAL', 'COMPLETED_WITH_ISSUES', 'UNKNOWN'].some((state) => result.jobs[state])) {
    issues.push('JOBS_UNHEALTHY')
  }
  return result
}
