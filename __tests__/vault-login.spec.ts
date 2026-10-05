import { Command } from 'commander'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startAuthServer } from '../src/auth-server'
import { CredentialStore } from '../src/vault/credential-store'
import { registerVaultCommands } from '../src/cli/vault-commands'

jest.mock('../src/auth-server', () => ({ startAuthServer: jest.fn() }))
jest.mock('open', () => ({ __esModule: true, default: jest.fn() }))

describe('Vault login clock tolerance', () => {
  const now = 1000000
  const originalExitCode = process.exitCode
  let directory: string
  let manifest: string
  let save: jest.SpyInstance
  let stop: jest.Mock
  beforeEach(() => {
    process.exitCode = undefined
    jest.spyOn(Date, 'now').mockReturnValue(now)
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
    save = jest.spyOn(CredentialStore.prototype, 'save').mockResolvedValue()
    stop = jest.fn()
    directory = mkdtempSync(join(tmpdir(), 'vault-login-'))
    manifest = join(directory, 'env.json')
    writeFileSync(manifest, JSON.stringify({ version: 1, apiUrl: 'https://api.example', tenant: 'tenant', project: 'project', profiles: { local: { service: 'api', environment: 'local' } } }))
  })
  afterEach(() => {
    jest.restoreAllMocks()
    process.exitCode = originalExitCode
    rmSync(directory, { recursive: true, force: true })
  })
  async function login(expiresAt: number) {
    (startAuthServer as jest.Mock).mockResolvedValue({ url: 'http://127.0.0.1:1234', nonce: 'nonce', stop, waitForCallback: async () => ({ token: 'vault:tenant:project:api:local:session:synthetic-token', vaultPublicKey: 'key', apiUrl: 'https://api.example', vaultPurpose: 'edit', expiresAt }) })
    const program = new Command()
    registerVaultCommands(program)
    await program.parseAsync(['node', 'cli', 'auth', 'login', '--purpose', 'edit', '--url', 'https://support.example', '--manifest', manifest])
  }
  it.each([0, 5000, 30000])('accepts an eight-hour response with clock skew %i ms without extending its expiry', async (skew) => {
    const expiresAt = now + 28800000 + skew
    await login(expiresAt)
    expect(save).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ expiresAt }))
    expect(process.exitCode).toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })
  it.each([now + 28830001, now, now - 1])('rejects out-of-range expiry %i without saving credentials', async (expiresAt) => {
    await login(expiresAt)
    expect(save).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
