import { spawn } from 'child_process'
import { createHash } from 'crypto'

import { trustedUrl, VaultScope } from './runtime'

export interface VaultLogin { token: string; publicKey: string; expiresAt: number }
export function credentialKey(apiUrl: string, scope: VaultScope, purpose: string): string {
  return createHash('sha256').update(JSON.stringify({ apiUrl: trustedUrl(apiUrl), scope, purpose })).digest('hex')
}
function invoke(binary: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output += data; if (output.length > 32768) child.kill() })
    // OS errors may echo credential input. Never surface stdout/stderr on failure.
    child.stderr.resume()
    child.once('error', () => reject(new Error('OS credential store is unavailable')))
    child.once('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error('OS credential store operation failed')))
    child.stdin.end(input)
  })
}
export class CredentialStore {
  async save(key: string, login: VaultLogin): Promise<void> {
    const payload = JSON.stringify(login)
    if (process.platform === 'darwin') {
      const quote = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
      // Interactive stdin keeps credentials out of process argv and shell history.
      await invoke('security', ['-i'], `add-generic-password -U -a ${quote(key)} -s ai-support-agent-vault -w ${quote(payload)}\n`)
    } else if (process.platform === 'linux') {
      await invoke('secret-tool', ['store', '--label=AI Support Agent Vault', 'service', 'ai-support-agent-vault', 'account', key], payload)
    } else throw new Error('Vault login currently requires macOS Keychain or Linux Secret Service')
    const stored = await this.load(key)
    if (stored.token !== login.token || stored.publicKey !== login.publicKey || stored.expiresAt !== login.expiresAt) throw new Error('OS credential store verification failed')
  }
  async load(key: string, allowExpired = false): Promise<VaultLogin> {
    const raw = process.platform === 'darwin' ? await invoke('security', ['find-generic-password', '-a', key, '-s', 'ai-support-agent-vault', '-w']) : process.platform === 'linux' ? await invoke('secret-tool', ['lookup', 'service', 'ai-support-agent-vault', 'account', key]) : ''
    try {
      const login = JSON.parse(raw) as VaultLogin
      if (!login.token?.startsWith('vault:') || !login.publicKey || !Number.isFinite(login.expiresAt) || (!allowExpired && login.expiresAt <= Date.now())) throw new Error()
      return login
    } catch { throw new Error('Vault session is missing or expired; run auth login') }
  }
  async remove(key: string): Promise<void> {
    if (process.platform === 'darwin') await invoke('security', ['delete-generic-password', '-a', key, '-s', 'ai-support-agent-vault'])
    else if (process.platform === 'linux') await invoke('secret-tool', ['clear', 'service', 'ai-support-agent-vault', 'account', key])
    else throw new Error('OS credential store is unavailable')
  }
}
