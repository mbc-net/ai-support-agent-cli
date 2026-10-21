import type { BackupInspectionRequest } from './backup-inspector'

const NAME = /^[a-zA-Z0-9_.-]{1,50}$/
const RESOURCE_TYPES = new Set(['RDS', 'Aurora', 'DynamoDB', 'S3', 'EC2', 'EBS', 'EFS'])

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function names(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= max &&
    value.every((name) => typeof name === 'string' && NAME.test(name)) && new Set(value).size === value.length
}

function days(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 36500
}

/** Reject extra fields: credentials, endpoints and arbitrary SDK options are never accepted. */
export function parseBackupInspectionRequest(input: unknown): BackupInspectionRequest {
  if (!object(input) || !keys(input, ['awsAccountId', 'region', 'planName', 'vaults', 'selectionNames', 'resourceTypes', 'lookbackHours']) ||
    typeof input.awsAccountId !== 'string' || !/^\d{12}$/.test(input.awsAccountId) ||
    typeof input.region !== 'string' || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(input.region) ||
    typeof input.planName !== 'string' || !NAME.test(input.planName) ||
    !names(input.selectionNames, 100) || !names(input.resourceTypes, 7) || !input.resourceTypes.every((type) => RESOURCE_TYPES.has(type)) ||
    !Number.isInteger(input.lookbackHours) || (input.lookbackHours as number) < 1 || (input.lookbackHours as number) > 336 ||
    !Array.isArray(input.vaults) || input.vaults.length < 1 || input.vaults.length > 20 ||
    !input.vaults.every((vault: unknown) => object(vault) && keys(vault, ['name', 'minRetentionDays', 'maxRetentionDays']) &&
      typeof vault.name === 'string' && /^[a-zA-Z0-9_-]{2,50}$/.test(vault.name) &&
      days(vault.minRetentionDays) && days(vault.maxRetentionDays) && vault.minRetentionDays <= vault.maxRetentionDays) ||
    new Set(input.vaults.map((vault: { name: string }) => vault.name)).size !== input.vaults.length) {
    throw new Error('BACKUP_INVALID_REQUEST')
  }
  // Validation above establishes every nested field. Copy arrays so asynchronous
  // inspection cannot observe a caller mutating the validated request.
  return {
    awsAccountId: input.awsAccountId, region: input.region, planName: input.planName,
    vaults: input.vaults.map((vault) => ({ ...vault })),
    selectionNames: [...input.selectionNames], resourceTypes: [...input.resourceTypes],
    lookbackHours: input.lookbackHours as number,
  }
}
