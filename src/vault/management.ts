import { Writable } from 'stream'
import { createInterface } from 'readline/promises'
import { randomUUID } from 'crypto'
import { CredentialStore, credentialKey } from './credential-store'
import { trustedUrl, VaultScope } from './runtime'

export function durationSeconds(value: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(value)
  const seconds = match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2]] ?? 0) : NaN
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 28800) throw new Error('Vault session duration must be between 1m and 8h')
  return seconds
}
export interface EditOptions { value?: string; secret?: boolean; stdin?: boolean; stripFinalNewline?: boolean; type?: string; required?: boolean; optional?: boolean; from?: string; operationId?: string }
export function editPayload(mode: string, name: string, opts: EditOptions): Record<string, unknown> {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error('Invalid Vault variable name')
  if (opts.value !== undefined && (opts.secret || opts.stdin)) throw new Error('Vault secret input must use a hidden prompt or --stdin; --value cannot be combined')
  if (opts.required && opts.optional) throw new Error('Vault schema cannot be both required and optional')
  if (opts.type !== undefined && !['string', 'number', 'boolean'].includes(opts.type)) throw new Error('Invalid Vault value type')
  return { mode, name, ...(opts.value !== undefined ? { value: opts.value } : {}), ...(opts.secret !== undefined ? { secret: opts.secret } : {}), ...(opts.from ? { from: opts.from } : {}), ...(opts.type ? { type: opts.type } : {}), ...(opts.required || opts.optional ? { required: !!opts.required } : {}) }
}
export async function readInput(opts: EditOptions): Promise<string> {
  let value = ''
  if (opts.stdin) {
    if (process.stdin.isTTY) throw new Error('Vault --stdin requires piped input')
    process.stdin.setEncoding('utf8')
    for await (const part of process.stdin) {
      value += part.toString()
      if (Buffer.byteLength(value) > 16384) throw new Error('Vault input exceeds 16KB')
    }
  } else {
    if (!opts.secret || !process.stdin.isTTY) throw new Error('Vault input requires --value, --stdin or an interactive --secret prompt')
    process.stderr.write('Secret value (hidden): ')
    const muted = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    const prompt = createInterface({ input: process.stdin, output: muted, terminal: true })
    try { value = await prompt.question('') } finally { prompt.close(); process.stderr.write('\n') }
  }
  if (opts.stripFinalNewline) value = value.replace(/\r?\n$/, '')
  if (Buffer.byteLength(value) > 16384 || value.includes('\0')) throw new Error('Invalid Vault input')
  return value
}
export interface ManagementView { version: number; activeReleaseId: string | null; releases: { id: string; baseReleaseId?: string; approval?: unknown; entries: { name: string; secretVersionId?: string }[] }[] }
export async function managementClient(apiUrl: string, scope: VaultScope, purpose: 'edit' | 'approve' | 'deploy') {
  const login = await new CredentialStore().load(credentialKey(apiUrl, scope, purpose))
  const parts = login.token.split(':')
  if (parts.length !== 7 || parts[0] !== 'vault' || parts.slice(1, 5).some((v, i) => v !== [scope.tenantCode, scope.projectCode, scope.serviceCode, scope.environment][i])) throw new Error('Vault credential scope mismatch')
  const base = `${trustedUrl(apiUrl)}/api/${encodeURIComponent(scope.tenantCode)}/projects/${encodeURIComponent(scope.projectCode)}/vault/${encodeURIComponent(scope.serviceCode)}/${encodeURIComponent(scope.environment)}/management`
  const request = async <T>(operation: string, payload: unknown): Promise<T> => {
    let response: Response
    try { response = await fetch(`${base}/${operation}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30000) }) }
    catch { throw new Error('Vault response unavailable; inspect the operation ID before retrying') }
    if (!response.ok) throw new Error(`Vault management rejected (${response.status}); inspect the operation ID before retrying`)
    return await response.json() as T
  }
  return {
    metadata: (releaseId?: string) => request<ManagementView>('metadata', releaseId ? { releaseId } : {}),
    operation: (operationId: string) => request<unknown>('operation', { operationId }),
    diff: (releaseId: string) => request<unknown>('diff', { releaseId }),
    command: async (view: ManagementView, action: string, payload: unknown, operationId: string = randomUUID()) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(operationId)) throw new Error('Invalid Vault operation ID')
      process.stderr.write(`Vault operation ID: ${operationId}\n`)
      return request<{ releaseId: string; version: number }>('command', { expectedVersion: view.version, action, payload, operationId })
    },
  }
}
