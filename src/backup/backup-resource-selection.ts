import type { BackupDatabaseEndpoint, BackupTenantContext } from './backup-source-secrets'

export type BackupLogicalResourceType = 'rds' | 'aurora' | 'dynamodb' | 's3'
export type BackupNativeResourceType = 'ec2' | 'ebs' | 'efs'
export interface BackupResourceTarget {
  type: BackupLogicalResourceType | BackupNativeResourceType
  selector: { mode: 'arn'; arns: string[] } | { mode: 'tag'; tagKey: string; tagValue: string }
}
export interface ResolvedBackupResource {
  type: BackupLogicalResourceType
  arn: string
  database?: BackupDatabaseEndpoint
  bucket?: string
  tableName?: string
}
export interface BackupResourceSelectionClient {
  accountId(): Promise<string | undefined>
  listTagged(type: BackupLogicalResourceType, key: string, value: string, token?: string): Promise<{ resources: { arn: string; tags: Record<string, string> }[]; nextToken?: string }>
  describe(type: BackupLogicalResourceType, arn: string): Promise<ResolvedBackupResource>
}
const LOGICAL = new Set(['rds', 'aurora', 'dynamodb', 's3'])
const NATIVE = new Set(['ec2', 'ebs', 'efs'])
const SAFE = new Set(['BACKUP_AWS_ACCOUNT_MISMATCH', 'BACKUP_EXPORT_SELECTION_EMPTY', 'BACKUP_EXPORT_SELECTION_CHANGED', 'BACKUP_EXPORT_PAGINATION_FAILED', 'BACKUP_EXPORT_RESOURCE_LIMIT', 'BACKUP_EXPORT_ABORTED', 'BACKUP_EXPORT_ENGINE_UNSUPPORTED'])
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function only(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)) }

export function isScopedBackupResourceArn(arn: unknown, type: BackupResourceTarget['type'], context: BackupTenantContext): arn is string {
  if (typeof arn !== 'string' || arn.length > 2048) return false
  const partition = context.region.startsWith('cn-') ? 'aws-cn' : context.region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws'
  if (type === 's3') return arn.startsWith(`arn:${partition}:s3:::`) && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(arn.slice(`arn:${partition}:s3:::`.length))
  const service = type === 'rds' || type === 'aurora' ? 'rds' : type === 'dynamodb' ? 'dynamodb' : type === 'efs' ? 'elasticfilesystem' : 'ec2'
  const prefix = `arn:${partition}:${service}:${context.region}:${context.accountId}:`
  if (!arn.startsWith(prefix)) return false
  const patterns = { rds: /^db:[A-Za-z][A-Za-z0-9-]{0,62}$/, aurora: /^cluster:[A-Za-z][A-Za-z0-9-]{0,62}$/, dynamodb: /^table\/[A-Za-z0-9_.-]{3,255}$/, ec2: /^instance\/i-[0-9a-f]+$/, ebs: /^volume\/vol-[0-9a-f]+$/, efs: /^file-system\/fs-[0-9a-f]+$/ }
  return patterns[type].test(arn.slice(prefix.length))
}

export function parseBackupResourceTargets(expected: BackupTenantContext, input: unknown): BackupResourceTarget[] {
  const context = { ...expected }
  if (!/^\d{12}$/.test(context.accountId) || !/^[a-z]{2}(?:-[a-z]+){1,3}-\d$/.test(context.region) || !Array.isArray(input) || !input.length || input.length > 20) throw new Error('BACKUP_EXPORT_INVALID_SELECTION')
  const targets: BackupResourceTarget[] = []
  for (const value of input as unknown[]) {
    if (!object(value) || !only(value, ['type', 'selector']) || typeof value.type !== 'string' || (!LOGICAL.has(value.type) && !NATIVE.has(value.type)) || !object(value.selector)) throw new Error('BACKUP_EXPORT_INVALID_SELECTION')
    const type = value.type as BackupResourceTarget['type']; const selector = value.selector
    if (selector.mode === 'arn') {
      if (!only(selector, ['mode', 'arns']) || !Array.isArray(selector.arns) || !selector.arns.length || selector.arns.length > 500 || !selector.arns.every((arn) => isScopedBackupResourceArn(arn, type, context))) throw new Error('BACKUP_EXPORT_INVALID_SELECTION')
      targets.push({ type, selector: { mode: 'arn', arns: [...selector.arns] } })
    } else if (selector.mode === 'tag') {
      if (!only(selector, ['mode', 'tagKey', 'tagValue']) || typeof selector.tagKey !== 'string' || !selector.tagKey || selector.tagKey.length > 128 ||
        typeof selector.tagValue !== 'string' || selector.tagValue.length > 256 || /[\x00-\x1f\x7f]/.test(selector.tagKey + selector.tagValue)) throw new Error('BACKUP_EXPORT_INVALID_SELECTION')
      targets.push({ type, selector: { mode: 'tag', tagKey: selector.tagKey, tagValue: selector.tagValue } })
    } else throw new Error('BACKUP_EXPORT_INVALID_SELECTION')
  }
  if (!targets.some((target) => LOGICAL.has(target.type))) throw new Error('BACKUP_EXPORT_NO_LOGICAL_TARGETS')
  return targets
}

/** Resolve the complete bounded selection before starting any data uploads. */
export async function resolveBackupResources(
  expected: BackupTenantContext, input: BackupResourceTarget[], client: BackupResourceSelectionClient, signal?: AbortSignal,
): Promise<{ resources: ResolvedBackupResource[]; nativeOnlyTypes: BackupNativeResourceType[] }> {
  const context = { ...expected }
  const targets = parseBackupResourceTargets(context, input)
  const check = (): void => { if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED') }
  const found = new Map<string, BackupLogicalResourceType>()
  const nativeOnlyTypes = [...new Set(targets.filter((target) => NATIVE.has(target.type)).map((target) => target.type as BackupNativeResourceType))]
  const add = (type: BackupLogicalResourceType, arn: string): void => {
    if (!isScopedBackupResourceArn(arn, type, context)) throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
    found.set(arn, type)
    if (found.size > 1000) throw new Error('BACKUP_EXPORT_RESOURCE_LIMIT')
  }
  try {
    check()
    if (await client.accountId() !== context.accountId) throw new Error('BACKUP_AWS_ACCOUNT_MISMATCH')
    check()
    for (const target of targets) {
      if (NATIVE.has(target.type)) continue
      const type = target.type as BackupLogicalResourceType
      if (target.selector.mode === 'arn') {
        for (const arn of target.selector.arns) add(type, arn)
      } else {
        const { tagKey, tagValue } = target.selector
        const tokens = new Set<string>(); let token: string | undefined; let count = 0
        for (let page = 0; ; page++) {
          check()
          if (page >= 1000) throw new Error('BACKUP_EXPORT_PAGINATION_FAILED')
          const result = await client.listTagged(type, tagKey, tagValue, token)
          check()
          for (const item of result.resources) {
            if (item.tags[tagKey] !== tagValue) throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
            add(type, item.arn); count++
          }
          token = result.nextToken
          if (!token) break
          if (tokens.has(token)) throw new Error('BACKUP_EXPORT_PAGINATION_FAILED')
          tokens.add(token)
        }
        if (!count) throw new Error('BACKUP_EXPORT_SELECTION_EMPTY')
      }
    }
    const resources: ResolvedBackupResource[] = []
    for (const [arn, type] of found) {
      check()
      const resource = await client.describe(type, arn)
      check()
      if (resource.arn !== arn || resource.type !== type) throw new Error('BACKUP_EXPORT_SELECTION_CHANGED')
      resources.push(resource)
    }
    return { resources, nativeOnlyTypes }
  } catch (error) {
    check()
    throw new Error(error instanceof Error && SAFE.has(error.message) ? error.message : 'BACKUP_EXPORT_SELECTION_FAILED')
  }
}
