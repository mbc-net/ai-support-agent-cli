import { Command } from 'commander'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { registerVaultCommands } from '../src/cli/vault-commands'
import { CredentialStore } from '../src/vault/credential-store'
import { VaultClient } from '../src/vault/runtime'

describe('vault logout cleanup', () => {
  const initialExitCode = process.exitCode
  let manifest: string
  let output: jest.SpyInstance
  let errors: jest.SpyInstance
  let remove: jest.SpyInstance
  let request: jest.SpyInstance
  beforeEach(() => {
    process.exitCode = undefined
    manifest = join(mkdtempSync(join(tmpdir(), 'vault-logout-')), 'manifest.json')
    writeFileSync(manifest, JSON.stringify({ version: 1, apiUrl: 'https://api.example.test', tenant: 'tenant', project: 'project', profiles: { local: { service: 'api', environment: 'local' } } }))
    jest.spyOn(CredentialStore.prototype, 'load').mockResolvedValue({ token: 'vault:tenant:project:api:local:subject:synthetic', publicKey: 'synthetic', expiresAt: Date.now() + 60000 })
    remove = jest.spyOn(CredentialStore.prototype, 'remove').mockResolvedValue(undefined)
    request = jest.spyOn(VaultClient.prototype, 'request').mockResolvedValue({} as never)
    output = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    errors = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => { jest.restoreAllMocks(); process.exitCode = initialExitCode })
  async function logout() {
    const program = new Command()
    registerVaultCommands(program)
    await program.parseAsync(['node', 'cli', 'auth', 'logout', '--manifest', manifest])
  }
  it('revokes the remote session and removes the local credential', async () => {
    await logout()
    expect(request).toHaveBeenCalledWith('logout')
    expect(remove).toHaveBeenCalledTimes(1)
    expect(output).toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })
  it.each([403, 503])('removes the local credential even when remote logout returns %i', async status => {
    request.mockRejectedValue(new Error(`Vault access rejected (${status}) synthetic-sensitive-data`))
    await logout()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls.flat().join('')).toContain('remote revocation could not be confirmed')
    expect(errors.mock.calls.flat().join('')).not.toContain('synthetic-sensitive-data')
    expect(output).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
  it('removes an expired credential without contacting the server', async () => {
    jest.mocked(CredentialStore.prototype.load).mockResolvedValue({ token: 'vault:tenant:project:api:local:subject:synthetic', publicKey: 'synthetic', expiresAt: Date.now() - 1000 })
    await logout()
    expect(request).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBeUndefined()
  })
  it('does not claim cleanup when the OS store rejects deletion', async () => {
    remove.mockRejectedValue(new Error('OS credential store operation failed'))
    await logout()
    expect(output).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
})
