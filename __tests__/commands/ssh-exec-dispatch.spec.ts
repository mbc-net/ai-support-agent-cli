/**
 * Dispatch tests for the `ssh_exec` command handler in src/commands/index.ts
 * (routing/validation only — the SSH execution logic itself is covered by
 * __tests__/commands/ssh-executor.spec.ts and the JIT credential fetch by
 * __tests__/commands/ssh-credential-client.spec.ts).
 */

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

const mockFetchSshExecCredential = jest.fn()
jest.mock('../../src/commands/ssh-credential-client', () => ({
  fetchSshExecCredential: (...args: unknown[]) => mockFetchSshExecCredential(...args),
}))

const mockExecuteSshCommand = jest.fn()
jest.mock('../../src/commands/ssh-executor', () => ({
  executeSshCommand: (...args: unknown[]) => mockExecuteSshCommand(...args),
}))

import { executeCommand } from '../../src/commands'
import type { ApiClient } from '../../src/api-client'

const FAKE_CLIENT = {} as ApiClient

beforeEach(() => {
  jest.clearAllMocks()
})

describe('ssh_exec dispatch', () => {
  it('requires client context', async () => {
    const result = await executeCommand('ssh_exec', {
      sshHostId: 'host-1',
      command: 'ls',
    })
    expect(result).toEqual({ success: false, error: 'ssh_exec requires client context' })
    expect(mockFetchSshExecCredential).not.toHaveBeenCalled()
  })

  it('requires commandId', async () => {
    const result = await executeCommand(
      'ssh_exec',
      { sshHostId: 'host-1', command: 'ls' },
      { client: FAKE_CLIENT },
    )
    expect(result).toEqual({ success: false, error: 'ssh_exec requires client context' })
  })

  it('requires sshHostId in the payload', async () => {
    const result = await executeCommand(
      'ssh_exec',
      { command: 'ls' },
      { client: FAKE_CLIENT, commandId: 'cmd-1' },
    )
    expect(result).toEqual({ success: false, error: 'sshHostId is required for ssh_exec' })
    expect(mockFetchSshExecCredential).not.toHaveBeenCalled()
  })

  it('requires command in the payload', async () => {
    const result = await executeCommand(
      'ssh_exec',
      { sshHostId: 'host-1' },
      { client: FAKE_CLIENT, commandId: 'cmd-1' },
    )
    expect(result).toEqual({ success: false, error: 'command is required for ssh_exec' })
    expect(mockFetchSshExecCredential).not.toHaveBeenCalled()
  })

  it('fetches the JIT credential and executes the command, returning success', async () => {
    const credential = { hostId: 'host-1', hostname: 'h', port: 22, username: 'u', authType: 'key', privateKey: 'k' }
    mockFetchSshExecCredential.mockResolvedValue(credential)
    mockExecuteSshCommand.mockResolvedValue('total 0\n')

    const result = await executeCommand(
      'ssh_exec',
      { sshHostId: 'host-1', command: 'ls -la', timeoutSeconds: 10 },
      { client: FAKE_CLIENT, commandId: 'cmd-1', agentId: 'agent-1' },
    )

    expect(mockFetchSshExecCredential).toHaveBeenCalledWith(FAKE_CLIENT, 'cmd-1', 'agent-1')
    expect(mockExecuteSshCommand).toHaveBeenCalledWith(credential, 'ls -la', 10)
    expect(result).toEqual({ success: true, data: 'total 0\n' })
  })

  it('passes undefined timeoutSeconds through when not specified', async () => {
    const credential = { hostId: 'host-1', hostname: 'h', port: 22, username: 'u', authType: 'key', privateKey: 'k' }
    mockFetchSshExecCredential.mockResolvedValue(credential)
    mockExecuteSshCommand.mockResolvedValue('ok')

    await executeCommand(
      'ssh_exec',
      { sshHostId: 'host-1', command: 'ls' },
      { client: FAKE_CLIENT, commandId: 'cmd-1' },
    )

    expect(mockExecuteSshCommand).toHaveBeenCalledWith(credential, 'ls', undefined)
  })

  it('returns an error result when the credential fetch fails', async () => {
    mockFetchSshExecCredential.mockRejectedValue(new Error('Failed to fetch SSH credential: 404'))

    const result = await executeCommand(
      'ssh_exec',
      { sshHostId: 'host-1', command: 'ls' },
      { client: FAKE_CLIENT, commandId: 'cmd-1' },
    )

    expect(result).toEqual({ success: false, error: 'Failed to fetch SSH credential: 404' })
    expect(mockExecuteSshCommand).not.toHaveBeenCalled()
  })

  it('returns an error result when SSH execution fails (e.g. Tailscale SOCKS5 failure), without falling back', async () => {
    const credential = { hostId: 'host-1', hostname: 'h', port: 22, username: 'u', authType: 'key', privateKey: 'k' }
    mockFetchSshExecCredential.mockResolvedValue(credential)
    mockExecuteSshCommand.mockRejectedValue(new Error('Failed to establish Tailscale SOCKS5 connection: ECONNREFUSED'))

    const result = await executeCommand(
      'ssh_exec',
      { sshHostId: 'host-1', command: 'ls' },
      { client: FAKE_CLIENT, commandId: 'cmd-1' },
    )

    expect(result).toEqual({
      success: false,
      error: 'Failed to establish Tailscale SOCKS5 connection: ECONNREFUSED',
    })
  })
})
