/** Dedicated resident-only SSH policy path. No recipe body or shell text is accepted. */
import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { readFileSync } from 'fs'
import { isIP } from 'net'
import { join } from 'path'
import { performance } from 'perf_hooks'
import type { Client, ConnectConfig } from 'ssh2'

import type { ApiClient } from '../api-client'
import { AGENT_MODE_ONESHOT, ONESHOT_ENV_VARS, TAILSCALE_SOCKS_PORT } from '../constants'
import { errorResult, successResult, type CommandResult, type SshExecCredential } from '../types'
import { validateSshCredential } from './server-setup-connection'

export const SSH_SOURCE_IP_CAPABILITY = 'ssh_source_ip_sync_v1'
const HELPER = '/usr/local/lib/ai-support-agent/ssh-policy.py'
const STATE = '/var/lib/ai-support-agent/ssh-policy'

export interface SshSourceIpPayload {
  attemptId: string
  policyId: string
  policyVersion: number
  definitionVersion: number
  sshHostId: string
  cidrs: string[]
  release: boolean
  keyOnly: boolean
  manageSources: boolean
  expectedHostKeySha256: string
  expectedRemovedRules?: string[]
  expectedMachineId?: string
}
export interface SshSourceIpReceipt {
  attemptId: string
  policyId: string
  policyVersion: number
  definitionVersion: number
  sshHostId: string
  status: 'pending' | 'succeeded' | 'recovered' | 'attention'
  machineId: string
  observedSourceIp?: string
  message?: string
  deadline: number
}
export type SshSourceIpInspectionResult = {machineId:string;removedRules:string[];observedSourceIp:string;port:number;managedRules?:boolean} | {error:string}
export interface SshSourceIpResult {
  attemptId: string
  policyVersion: number
  definitionVersion: number
  status: 'pending' | 'succeeded' | 'recovered' | 'attention'
  observedSourceIp?: string
  message?: string
  receipt?: SshSourceIpReceipt
}
interface Context { commandId: string; agentId?: string; client: ApiClient }

export function validateSyncPayload(value: unknown, inspectOnly = false): SshSourceIpPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid SSH policy payload')
  const p = value as SshSourceIpPayload
  for (const key of ['attemptId', 'policyId', 'sshHostId'] as const) {
    if (typeof p[key] !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p[key])) throw new Error(`Invalid ${key}`)
  }
  for (const version of [p.policyVersion,p.definitionVersion]) {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid policy/definition version')
  }
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(p.expectedHostKeySha256)) throw new Error('Registered SHA256 SSH host key required')
  for (const key of ['release','keyOnly','manageSources'] as const) if (typeof p[key] !== 'boolean') throw new Error(`Invalid ${key}`)
  if (p.release && !p.manageSources) throw new Error('Release requires a managed source policy')
  if (!Array.isArray(p.cidrs) || p.cidrs.length > 512 || p.cidrs.some(c => typeof c !== 'string' || c.length > 64)) throw new Error('Invalid CIDRs')
  if (!inspectOnly && p.manageSources && !p.release && !p.cidrs.length) throw new Error('Empty sources cannot remove restrictions')
  if ((!p.manageSources || p.release) && p.cidrs.length) throw new Error('Unexpected sources')
  if (p.expectedRemovedRules !== undefined && (!Array.isArray(p.expectedRemovedRules) || p.expectedRemovedRules.length > 1024 || p.expectedRemovedRules.some(r => typeof r !== 'string' || r.length > 4096))) throw new Error('Invalid firewall preview')
  if (p.expectedMachineId !== undefined && !/^[a-f0-9]{32}$/.test(p.expectedMachineId)) throw new Error('Invalid server identity')
  return p
}

export function verifyReceipt(value: unknown, p: SshSourceIpPayload): asserts value is SshSourceIpReceipt {
  if (!value || typeof value !== 'object') throw new Error('Missing server receipt')
  const receipt = value as SshSourceIpReceipt
  for (const key of ['attemptId','policyId','policyVersion','definitionVersion','sshHostId'] as const) {
    if (receipt[key] !== p[key]) throw new Error(`Server receipt does not match ${key}`)
  }
  if (!['pending','succeeded','recovered','attention'].includes(receipt.status)) throw new Error('Invalid server receipt status')
}

class SshHandshakeUnavailable extends Error {}

/** Each invocation allocates a NEW ssh2 Client; no pooled/control-master session is reused. */
export async function freshSsh(credential: SshExecCredential, fingerprint: string, command: string, input: string, timeoutMs = 120_000): Promise<string> {
  const started = performance.now()
  const { Client: SshClient } = await import('ssh2')
  let sock: ConnectConfig['sock']
  if (credential.connectionType === 'tailscale') {
    const { SocksClient } = await import('socks')
    sock = (await SocksClient.createConnection({
      proxy: {host:'127.0.0.1',port:credential.socksPort ?? TAILSCALE_SOCKS_PORT,type:5},
      command:'connect',destination:{host:credential.tailnetHostname!,port:credential.port},timeout:Math.min(20_000,timeoutMs),
    })).socket
  }
  const remainingMs = timeoutMs - (performance.now() - started)
  if (remainingMs <= 0) { sock?.destroy(); throw new SshHandshakeUnavailable('SSH connection budget exceeded') }
  const pin = Buffer.from(fingerprint.slice(7), 'base64')
  return new Promise((resolve,reject) => {
    const conn: Client = new SshClient()
    let stdout = '', stderr = '', settled = false, ready = false, hostRejected = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.destroy()
      sock?.destroy()
      if (error) {
        const network = error as Error & {code?: string; level?: string}
        const transient = ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE'].includes(network.code ?? '')
          || ['Connection lost before handshake','SSH connection closed before command completion','SSH policy command timed out'].includes(error.message)
        if (!ready && !hostRejected && network.level !== 'client-authentication' && transient) reject(new SshHandshakeUnavailable(error.message))
        else reject(error)
      } else resolve(stdout)
    }
    const timer = setTimeout(() => finish(new Error('SSH policy command timed out')), remainingMs)
    conn.on('error', error => finish(error))
    conn.on('close', () => { if (!settled) finish(new Error('SSH connection closed before command completion')) })
    conn.on('ready', () => { ready = true; conn.exec(command, (error, stream) => {
      if (error) { finish(error); return }
      stream.on('data', (data: Buffer) => {
        stdout += data.toString()
        if (stdout.length > 1024 * 1024) finish(new Error('SSH policy output limit exceeded'))
      })
      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
        if (stderr.length > 16384) finish(new Error('SSH policy error output limit exceeded'))
      })
      stream.on('error', (error: Error) => finish(error))
      stream.on('close', (code: number) => finish(code === 0 ? undefined : new Error(stderr.trim() || `SSH policy helper exited ${code}`)))
      stream.end(input)
    }) })
    try { conn.connect({host:credential.hostname,port:credential.port,username:credential.username,privateKey:credential.privateKey,
      sock,tryKeyboard:false,readyTimeout:Math.min(20_000,remainingMs),
      hostVerifier: (key: Buffer) => { const hash = createHash('sha256').update(key).digest(); const accepted = pin.length === hash.length && timingSafeEqual(pin,hash); hostRejected = !accepted; return accepted },
    }) } catch (error) { finish(error instanceof Error ? error : new Error('SSH connection failed')) }
  })
}

/** Only pre-authentication transport resets/refusals may retry; never repeat apply. */
async function confirmWithFreshConnections(credential: SshExecCredential, p: SshSourceIpPayload, proof: unknown): Promise<unknown> {
  const deadline = performance.now() + 20_000
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) break
    try {
      return JSON.parse(await freshSsh(credential,p.expectedHostKeySha256,
        `sudo -n /usr/bin/python3 ${HELPER} confirm "$SSH_CONNECTION"`,
        JSON.stringify(proof), Math.min(10_000,remaining)))
    } catch (error) {
      if (!(error instanceof SshHandshakeUnavailable)) throw error
      last = error
      if (attempt < 2 && deadline - performance.now() > 250) await new Promise(resolve => setTimeout(resolve,250))
    }
  }
  throw last ?? new Error('Fresh SSH confirmation connection budget exceeded')
}

// Root-owned installer uses stdin, never interpolates a credential or policy in shell text.
// Keep the original helper during a pending transaction, including across agent upgrades.
const INSTALLER = `import sys,os,pathlib,fcntl,json,hashlib\np=pathlib.Path('${STATE}')\np.mkdir(parents=True,exist_ok=True,mode=0o700)\nos.chmod(p,0o700)\nf=(p/'lock').open('a')\nfcntl.flock(f,fcntl.LOCK_EX)\nt=pathlib.Path('${HELPER}')\nb=sys.stdin.buffer.read(262144)\na=p/'attempt.json'\ns=json.loads(a.read_text()) if a.exists() else {}\nif s.get('status') == 'pending':\n assert t.exists(), 'Pending recovery helper is missing'\n print('pending-kept');sys.exit(0)\nt.parent.mkdir(parents=True,exist_ok=True,mode=0o755)\nx=t.with_suffix('.new')\nfd=os.open(x,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o700)\nwith os.fdopen(fd,'wb') as o:\n o.write(b);o.flush();os.fsync(o.fileno())\nos.chmod(x,0o700)\nos.replace(x,t)\nprint('installed')`
// INSTALLER contains single quotes, so encode only this fixed, audited program.
const SAFE_INSTALL_COMMAND = "sudo -n /usr/bin/python3 -c \"import base64;exec(base64.b64decode('" + Buffer.from(INSTALLER).toString('base64') + "'))\""

export async function runSshSourceIpSync(value: unknown, context: Context, inspectOnly = false): Promise<CommandResult> {
  let payload: SshSourceIpPayload | undefined
  let lastReceipt: SshSourceIpReceipt | undefined
  let readStatus: (() => Promise<unknown>) | undefined
  let applyStarted = false
  try {
    if (process.env[ONESHOT_ENV_VARS.AGENT_MODE] === AGENT_MODE_ONESHOT) throw new Error('SSH policies require a resident agent')
    if (!context.agentId) throw new Error('Resident agent identity is required')
    payload = validateSyncPayload(value, inspectOnly)
    const p = payload
    const credential = await context.client.getSshSourceIpCredential(context.commandId, context.agentId)
    const invalid = validateSshCredential(credential)
    if (invalid) throw new Error(invalid)
    if (credential.authType !== 'privateKey' || credential.os === 'windows' || credential.hostId !== p.sshHostId) throw new Error('SSH policy requires the matching Linux host and private-key authentication')
    const invoke = async (action: 'status'|'inspect'|'apply'|'confirm', request: unknown): Promise<unknown> => JSON.parse(await freshSsh(credential, p.expectedHostKeySha256, `sudo -n /usr/bin/python3 ${HELPER} ${action} "$SSH_CONNECTION"`, JSON.stringify(request)))
    await freshSsh(credential,p.expectedHostKeySha256,SAFE_INSTALL_COMMAND,readFileSync(join(__dirname,'../../ansible/ssh-policy/ssh-policy.py'),'utf8'))
    const nonce = randomBytes(32).toString('hex')
    const request = {...p,expectedRemovedRules:p.expectedRemovedRules ?? [],port:credential.port,username:credential.username,nonceHash:createHash('sha256').update(nonce).digest('hex')}
    readStatus = () => invoke('status',{attemptId:p.attemptId})
    const previous = await invoke('status',{attemptId:p.attemptId}) as {status: string}
    if (!inspectOnly && previous.status !== 'absent') {
      verifyReceipt(previous,p)
      lastReceipt = previous
    } else {
      const inspection = await invoke('inspect',request) as {machineId:string;removedRules:string[];managedRules?:boolean;observedSourceIp?:string;port?:number}
      if (inspectOnly) return {...successResult(inspection),sshSourceIpInspectionCompletion:inspection as SshSourceIpInspectionResult}
      if (p.expectedMachineId && p.expectedMachineId !== inspection.machineId) throw new Error('Server identity changed since approved preview')
      if (!inspection.managedRules && JSON.stringify(inspection.removedRules) !== JSON.stringify(request.expectedRemovedRules)) throw new Error('Existing SSH rules differ from the approved adoption preview')
      applyStarted = true
      const applied = await invoke('apply',{...request,machineId:inspection.machineId})
      verifyReceipt(applied,p)
      lastReceipt = applied
      if (applied.status === 'pending') {
        // A separate connection is opened AFTER apply returns, authenticates
        // with the registered key, pins the host key, then commits with nonce.
        const confirmed = await confirmWithFreshConnections(credential,p,{attemptId:p.attemptId,policyVersion:p.policyVersion,definitionVersion:p.definitionVersion,machineId:inspection.machineId,nonce})
        verifyReceipt(confirmed,p)
        lastReceipt = confirmed
      }
    }
    const result: SshSourceIpResult = {attemptId:p.attemptId,policyVersion:p.policyVersion,definitionVersion:p.definitionVersion,status:lastReceipt.status,observedSourceIp:lastReceipt.observedSourceIp,message:lastReceipt.message,receipt:lastReceipt}
    if (result.observedSourceIp && !isIP(result.observedSourceIp)) throw new Error('Invalid observed source address')
    return {...successResult(result), sshSourceIpCompletion:result}
  } catch (error) {
    const message = error instanceof Error ? error.message : 'SSH policy failed'
    if (payload && readStatus && !inspectOnly && (applyStarted || lastReceipt)) {
      try {
        const actual = await readStatus()
        verifyReceipt(actual,payload)
        lastReceipt = actual
      } catch { /* Transport loss leaves the durable server timer authoritative. */ }
    }
    // Persist the dedicated result through the normal write-before-submit
    // pending-result store. Never downgrade a server-confirmed success merely
    // because an API acknowledgement was lost.
    if (payload && context.agentId && !inspectOnly) {
      const completion: SshSourceIpResult = {
        attemptId:payload.attemptId, policyVersion:payload.policyVersion,
        definitionVersion:payload.definitionVersion,
        status:lastReceipt?.status ?? (applyStarted ? 'pending' : 'attention'),
        observedSourceIp:lastReceipt?.observedSourceIp, message, receipt:lastReceipt,
      }
      return {...errorResult(message), sshSourceIpCompletion:completion}
    }
    if (inspectOnly) return {...errorResult(message),sshSourceIpInspectionCompletion:{error:message.slice(0,2000)}}
    return errorResult(message)
  }
}
