import type { Command } from 'commander'
import { readFileSync } from 'fs'
import { load } from 'js-yaml'

import { startAuthServer } from '../auth-server'
import { CredentialStore, credentialKey } from '../vault/credential-store'
import { exportEnv, runWithVault, trustedUrl, VAULT_CLOCK_SKEW_MS, VaultClient, VaultScope } from '../vault/runtime'
import { durationSeconds, editPayload, readInput, managementClient, EditOptions } from '../vault/management'
import { workloadProof } from '../vault/iam'

interface Options { manifest: string; profile: string; purpose?: string; url?: string; output?: string; workload?: boolean; publicKey?: string; iam?: boolean; workloadId?: string; region?: string; leaseCache?: string; sessionDuration?: string }
interface Profile { service: string; environment: string; required?: string[] }
export function readProfile(file: string, profileName: string): { apiUrl: string; scope: VaultScope; required: string[] } {
  const manifest = load(readFileSync(file, 'utf8')) as { version: number; apiUrl: string; tenant: string; project: string; profiles: Record<string, Profile> }
  const profile = manifest?.profiles?.[profileName]
  if (manifest?.version !== 1 || !profile || !manifest.tenant || !manifest.project || !profile.service) throw new Error('Invalid vault manifest or profile')
  return { apiUrl: trustedUrl(manifest.apiUrl), scope: { tenantCode: manifest.tenant, projectCode: manifest.project, serviceCode: profile.service, environment: profile.environment }, required: profile.required ?? [] }
}
function options(command: Command): Command {
  return command.option('--manifest <path>', 'Vault profile manifest', '.ai-support/env.yaml').option('--profile <name>', 'Profile to use', 'local')
}
async function safe(action: () => Promise<void>) {
  try { await action() } catch (error) {
    // HTTP/AWS/child errors can contain credentials. Only expose errors created here.
    const message = error instanceof Error && /^(Vault |Invalid |Unsafe |Incomplete |Output |This value|OS credential|A command|Target secret|Missing target|Unable to retrieve)/.test(error.message) ? error.message : 'Vault operation failed'
    process.stderr.write(message + '\n'); process.exitCode = 1
  }
}
async function clientFor(opts: Options, purpose: 'run' | 'export' = 'run') {
  const profile = readProfile(opts.manifest, opts.profile)
  if (opts.iam) {
    if (!opts.publicKey || !opts.workloadId || !opts.region) throw new Error('Vault IAM requires --public-key, --workload-id and --region')
    return { ...profile, client: new VaultClient(profile.apiUrl, profile.scope, () => workloadProof(profile.scope, opts.region!), readFileSync(opts.publicKey, 'utf8'), opts.workloadId, opts.leaseCache) }
  }
  let token: string; let publicKey: string
  if (opts.workload) {
    token = process.env.VAULT_WORKLOAD_TOKEN ?? ''
    publicKey = opts.publicKey ? readFileSync(opts.publicKey, 'utf8') : ''
    if (!token || !publicKey) throw new Error('Vault workload requires VAULT_WORKLOAD_TOKEN and --public-key')
  } else {
    const login = await new CredentialStore().load(credentialKey(profile.apiUrl, profile.scope, purpose))
    token = login.token; publicKey = login.publicKey
  }
  return { ...profile, client: new VaultClient(profile.apiUrl, profile.scope, token, publicKey, undefined, opts.workload ? opts.leaseCache : undefined) }
}
export function registerVaultCommands(program: Command): void {
  const auth = program.command('auth').description('Local development vault authentication')
  options(auth.command('login')).requiredOption('--url <url>', 'Support site URL').option('--purpose <purpose>', 'run, export, edit, approve or deploy', 'run').option('--session-duration <duration>', 'Requested session lifetime, e.g. 8h').action((opts: Options) => safe(async () => {
    const { apiUrl, scope } = readProfile(opts.manifest, opts.profile)
    if (!['run', 'export', 'edit', 'approve', 'deploy'].includes(opts.purpose!) || (scope.environment !== 'local' && ['run', 'export'].includes(opts.purpose!))) throw new Error('Vault login purpose or environment is invalid')
    const duration = opts.sessionDuration ? durationSeconds(opts.sessionDuration) : undefined
    const site = trustedUrl(opts.url!)
    const server = await startAuthServer(undefined, new URL(site).origin)
    try {
      // Register before opening the browser so a fast callback cannot be lost.
      const pending = server.waitForCallback()
      void pending.catch(() => {})
      const url = new URL(`${site}/vault-callback`)
      url.searchParams.set('callbackUrl', `${server.url}/callback`); url.searchParams.set('nonce', server.nonce)
      url.searchParams.set('tenantCode', scope.tenantCode); url.searchParams.set('projectCode', scope.projectCode)
      url.searchParams.set('serviceCode', scope.serviceCode); url.searchParams.set('environment', scope.environment)
      if (duration) url.searchParams.set('durationSeconds', String(duration))
      url.searchParams.set('purpose', opts.purpose!); url.searchParams.set('apiUrl', apiUrl)
      const openBrowser = (await import('open')).default
      await openBrowser(url.href)
      const result = await pending
      if (!result.vaultPublicKey || !result.expiresAt || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 28800000 + VAULT_CLOCK_SKEW_MS || result.vaultPurpose !== opts.purpose || trustedUrl(result.apiUrl ?? '') !== apiUrl) throw new Error('Vault login response mismatch')
      new VaultClient(apiUrl, scope, result.token, result.vaultPublicKey)
      await new CredentialStore().save(credentialKey(apiUrl, scope, opts.purpose!), { token: result.token, publicKey: result.vaultPublicKey, expiresAt: result.expiresAt })
      process.stdout.write(`Vault session saved in the OS credential store. Expires: ${new Date(result.expiresAt).toISOString()}\n`)
    } finally { server.stop() }
  }))
  options(auth.command('logout')).option('--purpose <purpose>', 'run or export', 'run').action((opts: Options) => safe(async () => {
    const p = readProfile(opts.manifest, opts.profile)
    const store = new CredentialStore(); const key = credentialKey(p.apiUrl, p.scope, opts.purpose!)
    let remoteConfirmed = false
    try {
      const login = await store.load(key, true)
      if (login.expiresAt > Date.now()) await new VaultClient(p.apiUrl, p.scope, login.token, login.publicKey).request('logout')
      remoteConfirmed = true // Expired credentials cannot be used again either.
    } catch { /* Local cleanup must still run; remote errors may contain credentials. */ }
    await store.remove(key)
    if (!remoteConfirmed) throw new Error('Vault credential removed from this device; remote revocation could not be confirmed. The remote session may remain valid until expiry.')
    process.stdout.write('Vault session expired or revoked and removed from this device.\n')
  }))
  const env = program.command('env').description('Use an approved environment release')
  options(env.command('check')).option('--workload', 'Use a workload credential').option('--iam', 'Use AWS workload identity').option('--workload-id <id>', 'Registered workload ID').option('--region <region>', 'STS identity region').option('--public-key <path>', 'Pinned lease verification key').action((opts: Options) => safe(async () => {
    const { client, required } = await clientFor(opts)
    const result = await client.request('check')
    if (required.some(name => !result.variables.some(v => v.name === name))) throw new Error('Incomplete vault release')
    process.stdout.write(JSON.stringify({ releaseId: result.releaseId, variables: result.variables.map(v => ({ name: v.name, secret: v.secret })) }, null, 2) + '\n')
  }))
  options(env.command('run')).option('--workload', 'Use a workload credential').option('--iam', 'Use AWS workload identity').option('--workload-id <id>', 'Registered workload ID').option('--region <region>', 'STS identity region').option('--lease-cache <path>', 'Persist signed nonsecret leases for bounded outage recovery').option('--public-key <path>', 'Pinned lease verification key').argument('<command...>', 'Command following --').allowUnknownOption(false).action((command: string[], opts: Options) => safe(async () => {
    const { client, required } = await clientFor(opts)
    process.exitCode = await runWithVault(client, command, opts.workload || opts.iam, required)
  }))
  options(env.command('pull')).requiredOption('--output <path>', 'Ignored, untracked output file').action((opts: Options) => safe(async () => {
    const { client } = await clientFor(opts, 'export')
    const result = await client.request('resolve')
    await exportEnv(opts.output!, await client.materialize(result))
    process.stdout.write('Vault environment file created with owner-only permissions.\n')
  }))
  for (const mode of ['add', 'set']) {
    options(env.command(mode)).argument('<name>', 'Environment variable name')
      .option('--value <value>', 'Nonsecret value only').option('--secret', 'Hidden secret input').option('--no-secret', 'Explicitly convert to a nonsecret value')
      .option('--stdin', 'Read value from stdin').option('--strip-final-newline', 'Explicitly remove one trailing newline')
      .option('--type <type>', 'string, number or boolean').option('--required', 'Require a nonempty value').option('--optional', 'Allow an empty value')
      .option('--from <release>', 'Base candidate release ID').option('--operation-id <id>', 'Reuse the ID of the same request after checking its result')
      .action((name: string, opts: Options & EditOptions) => safe(async () => {
        const payload = editPayload(mode, name, opts)
        const profile = readProfile(opts.manifest, opts.profile)
        const client = await managementClient(profile.apiUrl, profile.scope, 'edit')
        const view = await client.metadata(opts.from)
        const base = view.releases.find(r => r.id === (opts.from ?? view.activeReleaseId))
        const old = base?.entries.find(e => e.name === name)
        if (old?.secretVersionId && opts.secret === undefined) throw new Error('Vault existing secret requires --secret or --no-secret')
        if (payload.value === undefined) payload.value = await readInput(opts)
        const result = await client.command(view, 'edit-release', payload, opts.operationId)
        process.stdout.write(JSON.stringify({ ...result, environment: profile.scope.environment, status: 'unapproved' }) + '\n')
      }))
  }
  options(env.command('status')).requiredOption('--operation-id <id>', 'Operation ID to inspect').option('--purpose <purpose>', 'Management session purpose', 'edit').action((opts: Options & { operationId: string }) => safe(async () => {
    const p = readProfile(opts.manifest, opts.profile)
    if (!['edit', 'approve', 'deploy'].includes(opts.purpose!)) throw new Error('Vault management purpose is required')
    const c = await managementClient(p.apiUrl, p.scope, opts.purpose as 'edit' | 'approve' | 'deploy')
    process.stdout.write(JSON.stringify(await c.operation(opts.operationId), null, 2) + '\n')
  }))
  options(env.command('diff')).requiredOption('--release <id>', 'Candidate release ID').option('--purpose <purpose>', 'Management session purpose', 'edit').action((opts: Options & { release: string }) => safe(async () => {
    const p = readProfile(opts.manifest, opts.profile)
    if (!['edit', 'approve', 'deploy'].includes(opts.purpose!)) throw new Error('Vault management purpose is required')
    const c = await managementClient(p.apiUrl, p.scope, opts.purpose as 'edit' | 'approve' | 'deploy')
    process.stdout.write(JSON.stringify(await c.diff(opts.release), null, 2) + '\n')
  }))
  for (const action of ['approve', 'stage', 'activate']) {
    options(env.command(action)).requiredOption('--release <id>', 'Immutable release ID')
      .option('--target <id>', 'Required deployment target for stage').option('--expected-active <id>', 'Expected currently active release (or none)')
      .option('--operation-id <id>', 'Idempotent operation ID')
      .action((opts: Options & { release: string; target?: string; expectedActive?: string; operationId?: string }) => safe(async () => {
        const p = readProfile(opts.manifest, opts.profile)
        const c = await managementClient(p.apiUrl, p.scope, action === 'approve' ? 'approve' : 'deploy')
        const view = await c.metadata()
        if (action === 'stage' && !opts.target) throw new Error('Vault stage requires --target')
        if (action === 'activate' && opts.expectedActive === undefined) throw new Error('Vault activate requires --expected-active (use none for first activation)')
        const payload = { releaseId: opts.release, ...(action === 'stage' ? { targetId: opts.target } : {}), ...(action === 'activate' ? { expectedActiveReleaseId: opts.expectedActive === 'none' ? null : opts.expectedActive } : {}) }
        process.stdout.write(JSON.stringify(await c.command(view, action, payload, opts.operationId)) + '\n')
      }))
  }

}
