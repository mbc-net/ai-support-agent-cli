import { execFile, spawn } from 'child_process'
import { createPublicKey, randomUUID, verify } from 'crypto'
import { open, lstat, realpath, unlink, readFile, writeFile, rename } from 'fs/promises'
import { dirname, resolve } from 'path'
import { promisify } from 'util'

export const VAULT_CLOCK_SKEW_MS = 30000

export interface VaultScope { tenantCode: string; projectCode: string; serviceCode: string; environment: string }
export interface LeaseClaims extends VaultScope { id: string; subject: string; releaseId: string; digest: string; issuedAt: number; expiresAt: number }
export interface Variable { name: string; secret: boolean; type?: string; required?: boolean }
export interface Bundle {
  releaseId: string; digest: string; variables: Variable[]; values?: Record<string, string>
  region?: string; secretId?: string; versionId?: string
  lease: { token: string; claims: LeaseClaims }
}
const exec = promisify(execFile)

export function trustedUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))) throw new Error('Vault URL requires HTTPS or loopback HTTP')
  return parsed.href.replace(/\/$/, '')
}
export function verifyLease(token: string, publicKey: string, scope: VaultScope, subject: string, releaseId: string, digest: string): LeaseClaims {
  try {
    const [payload, signature, extra] = token.split('.')
    const key = createPublicKey(publicKey)
    if (key.asymmetricKeyType !== 'ed25519' || !payload || !signature || extra || !verify(null, Buffer.from(payload), key, Buffer.from(signature, 'base64url'))) throw new Error()
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as LeaseClaims
    if (claims.subject !== subject || claims.releaseId !== releaseId || claims.digest !== digest || !Number.isFinite(claims.expiresAt) || !Number.isFinite(claims.issuedAt) || claims.expiresAt <= Date.now() || claims.issuedAt > Date.now() + VAULT_CLOCK_SKEW_MS || claims.expiresAt - claims.issuedAt > 3600000 || (['tenantCode', 'projectCode', 'serviceCode', 'environment'] as const).some(k => claims[k] !== scope[k])) throw new Error()
    return claims
  } catch { throw new Error('Invalid, mismatched or expired vault lease') }
}
export function validateValues(values: Record<string, string>, variables: Variable[]): void {
  if (!values || typeof values !== 'object' || !Array.isArray(variables) || variables.length > 64 || new Set(variables.map(v => v.name)).size !== variables.length || Object.keys(values).length !== variables.length) throw new Error('Incomplete vault bundle')
  for (const v of variables) {
    const value = values[v.name]
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(v.name) || /^(NODE_OPTIONS|NODE_PATH|PATH|HOME|SHELL|BASH_ENV|ENV|IFS|LD_.*|DYLD_.*|AI_SUPPORT_AGENT_.*|VAULT_.*)$/.test(v.name) || (v.secret && /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_)/.test(v.name))) throw new Error('Unsafe vault environment variable')
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 16384 || (v.required && value.length === 0)) throw new Error('Invalid vault value')
    if (v.type === 'number' && (!value.trim() || !Number.isFinite(Number(value)))) throw new Error('Invalid numeric vault value')
    if (v.type === 'boolean' && value !== 'true' && value !== 'false') throw new Error('Invalid boolean vault value')
  }
}
function transientFailure(error: unknown): boolean {
  return error instanceof TypeError || (error as Error).name === 'TimeoutError' || /rejected \(5\d\d\)/.test((error as Error).message)
}
export class VaultClient {
  readonly baseUrl: string
  readonly subject: string
  constructor(readonly apiUrl: string, readonly scope: VaultScope, private readonly credential: string | (() => Promise<string>), readonly publicKey: string, workloadId?: string, private readonly leaseCache?: string) {
    const parts = typeof credential === 'string' ? credential.split(':') : []
    if (typeof credential === 'string' && (parts.length !== 7 || parts[0] !== 'vault' || parts.slice(1, 5).some((v, i) => v !== [scope.tenantCode, scope.projectCode, scope.serviceCode, scope.environment][i]))) throw new Error('Vault credential scope mismatch')
    if (typeof credential !== 'string' && !workloadId) throw new Error('Vault workload ID is required')
    for (const v of [scope.tenantCode, scope.projectCode, scope.serviceCode]) if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(v)) throw new Error('Invalid vault scope')
    if (!['local', 'development', 'test', 'production'].includes(scope.environment)) throw new Error('Invalid vault environment')
    this.subject = workloadId ?? parts[5]
    this.baseUrl = `${trustedUrl(apiUrl)}/api/${scope.tenantCode}/projects/${scope.projectCode}/vault/${scope.serviceCode}/${scope.environment}/access`
  }
  async request(operation: string, releaseId?: string): Promise<Bundle> {
    try {
      const credential = typeof this.credential === 'string' ? this.credential : await this.credential()
      const response = await fetch(`${this.baseUrl}/${operation}`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify(releaseId ? { releaseId } : {}), signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error(`Vault request rejected (${response.status})`)
      const bundle = await response.json() as Bundle
      if (operation !== 'check' && operation !== 'logout') bundle.lease.claims = verifyLease(bundle.lease.token, this.publicKey, this.scope, this.subject, bundle.releaseId, bundle.digest)
      if (operation === 'lease' && this.leaseCache) {
        if (bundle.values) throw new Error('Vault lease cache cannot contain secret values')
        const temporary = `${this.leaseCache}.${randomUUID()}.tmp`
        try { await writeFile(temporary, JSON.stringify(bundle), { mode: 0o600, flag: 'wx' }); await rename(temporary, this.leaseCache) }
        finally { await unlink(temporary).catch(() => {}) }
      }
      return bundle
    } catch (error) {
      const transient = transientFailure(error)
      if (operation !== 'lease' || !this.leaseCache || !transient) throw error
      const cached = JSON.parse(await readFile(this.leaseCache, 'utf8')) as Bundle
      if (cached.values || (releaseId && cached.releaseId !== releaseId)) throw new Error('Invalid vault lease cache')
      cached.lease.claims = verifyLease(cached.lease.token, this.publicKey, this.scope, this.subject, cached.releaseId, cached.digest)
      return cached
    }
  }
  async materialize(bundle: Bundle): Promise<Record<string, string>> {
    if (bundle.values) { validateValues(bundle.values, bundle.variables); return bundle.values }
    if (!bundle.region || !bundle.secretId || !bundle.versionId) throw new Error('Missing target secret version')
    let raw: string
    try {
      const awsEnv = { ...process.env, AWS_PAGER: '' }
      for (const key of Object.keys(awsEnv)) if (/^(VAULT_|AI_SUPPORT_AGENT_)/.test(key)) delete awsEnv[key as keyof typeof awsEnv]
      const response = await exec('aws', ['secretsmanager', 'get-secret-value', '--region', bundle.region, '--secret-id', bundle.secretId, '--version-id', bundle.versionId, '--output', 'json'], { maxBuffer: 1024 * 1024, timeout: 10000, env: awsEnv })
      raw = JSON.parse(response.stdout).SecretString
    } catch { throw new Error('Unable to retrieve the pinned target secret') }
    const payload = JSON.parse(raw)
    if (payload.schemaVersion !== 1 || payload.releaseId !== bundle.releaseId || payload.digest !== bundle.digest || (['tenantCode', 'projectCode', 'serviceCode', 'environment'] as const).some(k => payload.scope?.[k] !== this.scope[k])) throw new Error('Target secret does not match the vault release')
    validateValues(payload.values, bundle.variables)
    return payload.values
  }
}

export async function gitIgnored(file: string): Promise<boolean> {
  try {
    const parent = await realpath(dirname(resolve(file)))
    const target = resolve(parent, file.split(/[\\/]/).pop()!)
    const tracked = await exec('git', ['ls-files', '--error-unmatch', '--', target], { cwd: parent }).then(() => true, () => false)
    if (tracked) return false
    await exec('git', ['check-ignore', '--quiet', '--no-index', '--', target], { cwd: parent })
    return true
  } catch { return false }
}
export async function exportEnv(file: string, values: Record<string, string>, ignored = gitIgnored): Promise<void> {
  const absolute = resolve(file)
  if (!await ignored(absolute)) throw new Error('Output must be untracked and ignored by Git')
  const parent = await realpath(dirname(absolute))
  if ((await lstat(dirname(absolute))).isSymbolicLink()) throw new Error('Output directory must not be a symlink')
  const canonical = resolve(parent, absolute.split(/[\\/]/).pop()!)
  const handle = await open(canonical, 'wx', 0o600)
  try {
    // Dotenv has no universal escaping standard. JSON-quoted strings work for
    // simple values; reject ambiguous characters instead of silently corrupting.
    if (Object.values(values).some(v => /[\r"`$\\]/.test(v))) throw new Error('This value cannot be safely exported; use env run')
    const content = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}="${value.replace(/\n/g, '\\n')}"`).join('\n') + '\n'
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } catch (error) { await handle.close(); await unlink(canonical); throw error }
  await handle.close()
}

/** A supervised process uses one release throughout its lifetime. Lease renewal
 * cannot change values; expiry or explicit rejection stops its process group. */
export async function runWithVault(client: VaultClient, command: string[], workload = false, required: string[] = []): Promise<number> {
  if (!command.length) throw new Error('A command is required after --')
  if (process.platform === 'win32') throw new Error('Vault env run requires macOS/Linux process group supervision')
  let bundle = await client.request(workload ? 'lease' : 'resolve')
  if (required.some(name => !bundle.variables.some(v => v.name === name))) throw new Error('Incomplete vault release')
  const values = await client.materialize(bundle)
  if (bundle.lease.claims.expiresAt <= Date.now()) throw new Error('Vault lease expired before startup')
  const env = { ...process.env, ...values }
  for (const key of Object.keys(env)) if (/^(VAULT_|AI_SUPPORT_AGENT_)/.test(key)) delete env[key]
  const child = spawn(command[0], command.slice(1), { env, stdio: 'inherit', shell: false, detached: true })
  const exited = new Promise<number>((resolveExit, reject) => { child.once('exit', (code, signal) => resolveExit(code ?? (signal === 'SIGINT' ? 130 : 143))); child.once('error', reject) })
  void exited.catch(() => {})
  let done = false
  let renewing = false
  let stopping = false
  let killTimer: NodeJS.Timeout | undefined
  const stop = (signal: NodeJS.Signals = 'SIGTERM') => {
    try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) } catch { /* already exited */ }
    if (!stopping && signal !== 'SIGKILL') {
      stopping = true
      killTimer = setTimeout(() => stop('SIGKILL'), 5000)
    }
  }
  let appliedPending = workload
  let reportingApplied = false
  let appliedRetryAt = 0
  let appliedRetryDelay = 1000
  const reportApplied = async () => {
    if (!appliedPending || reportingApplied || done || stopping || Date.now() < appliedRetryAt || Date.now() >= bundle.lease.claims.expiresAt) return
    reportingApplied = true
    try {
      await client.request('applied', bundle.releaseId)
      appliedPending = false
    } catch (error) {
      if (!transientFailure(error)) stop()
      else {
        appliedRetryAt = Date.now() + appliedRetryDelay
        appliedRetryDelay = Math.min(appliedRetryDelay * 2, 30000)
      }
    } finally { reportingApplied = false }
  }
  const interrupted = () => stop('SIGINT')
  const terminated = () => stop('SIGTERM')
  process.on('SIGINT', interrupted); process.on('SIGTERM', terminated)
  const timer = setInterval(async () => {
    if (done || stopping) return
    if (Date.now() >= bundle.lease.claims.expiresAt) { stop(); return }
    const renewalAt = bundle.lease.claims.issuedAt + (bundle.lease.claims.expiresAt - bundle.lease.claims.issuedAt) * 0.6
    // Serialize writes for this credential; concurrent lease/applied requests
    // would contend on the vault's aggregate version.
    if (renewing || reportingApplied) return
    if (Date.now() < renewalAt) { await reportApplied(); return }
    renewing = true
    try {
      const renewed = await client.request(workload ? 'lease' : 'resolve', bundle.releaseId)
      if (renewed.digest !== bundle.digest) throw new Error('Release changed')
      bundle = renewed
    } catch (error) {
      // Network/5xx failure may retry until expiry. Explicit 4xx denies stop immediately.
      if (!transientFailure(error)) stop()
    } finally { renewing = false }
    await reportApplied()
  }, 1000)
  try {
    await new Promise<void>((resolveStarted, reject) => { child.once('spawn', resolveStarted); child.once('error', reject) })
    // "Applied" means the process was launched with this version, not healthy.
    await reportApplied()
    return await exited
  } finally {
    done = true; clearInterval(timer)
    // A terminated parent can leave descendants in its process group.
    stop('SIGKILL')
    if (killTimer) clearTimeout(killTimer)
    process.off('SIGINT', interrupted); process.off('SIGTERM', terminated)
  }
}
