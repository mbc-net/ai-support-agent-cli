import { Command } from 'commander'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerVaultCommands } from '../src/cli/vault-commands'
import * as management from '../src/vault/management'

describe('Vault editing and deployment commands', () => {
  let manifest: string
  let command: jest.Mock
  let out: jest.SpyInstance
  const initialExitCode = process.exitCode
  beforeEach(() => {
    process.exitCode = undefined
    manifest = join(mkdtempSync(join(tmpdir(), 'vault-management-')), 'env.json')
    writeFileSync(manifest, JSON.stringify({ version: 1, apiUrl: 'https://api.example', tenant: 'tenant', project: 'project', profiles: { local: { service: 'api', environment: 'local' } } }))
    command = jest.fn().mockResolvedValue({ releaseId: 'candidate', version: 2 })
    jest.spyOn(management, 'managementClient').mockResolvedValue({ metadata: async () => ({ version: 1, activeReleaseId: null, releases: [] }), command, diff: async () => ({}), operation: async () => ({}) })
    out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })
  afterEach(() => { jest.restoreAllMocks(); process.exitCode = initialExitCode })
  async function run(args: string[]) {
    const p = new Command(); registerVaultCommands(p)
    await p.parseAsync(['node', 'cli', 'env', ...args, '--manifest', manifest])
  }
  it('creates a nonsecret candidate without implicit secret flags', async () => {
    await run(['add', 'LOG_LEVEL', '--value', 'debug'])
    expect(command.mock.calls[0][1]).toBe('edit-release')
    expect(command.mock.calls[0][2]).toEqual({ mode: 'add', name: 'LOG_LEVEL', value: 'debug' })
    expect(out.mock.calls.flat().join('')).toContain('unapproved')
  })
  it('rejects secret values in argv before contacting the server', async () => {
    await run(['add', 'PASSWORD', '--secret', '--value', 'synthetic-secret'])
    expect(command).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
    expect(out.mock.calls.flat().join('')).not.toContain('synthetic-secret')
  })
  it('requires an explicit expected active release before activation', async () => {
    await run(['activate', '--release', 'candidate'])
    expect(command).not.toHaveBeenCalled()
    expect(process.exitCode).toBe(1)
  })
  it('uses a deploy session and expected active null for first activation', async () => {
    await run(['activate', '--release', 'candidate', '--expected-active', 'none'])
    expect(management.managementClient).toHaveBeenCalledWith(expect.any(String), expect.any(Object), 'deploy')
    expect(command.mock.calls[0][2]).toEqual({ releaseId: 'candidate', expectedActiveReleaseId: null })
  })
})
