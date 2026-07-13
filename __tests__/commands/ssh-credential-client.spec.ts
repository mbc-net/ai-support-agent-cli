/**
 * Tests for src/commands/ssh-credential-client.ts.
 *
 * Covers the JIT credential fetch used by the `ssh_exec` command handler:
 * delegating to `ApiClient.getSshExecCredential`, wrapping fetch failures
 * with context (without leaking any credential material), and never logging
 * the resolved credential.
 */

const mockLoggerDebug = jest.fn()
const mockLoggerError = jest.fn()
jest.mock('../../src/logger', () => ({
  logger: {
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    info: jest.fn(),
    warn: jest.fn(),
    success: jest.fn(),
  },
}))

import { fetchSshExecCredential } from '../../src/commands/ssh-credential-client'
import type { ApiClient } from '../../src/api-client'
import type { SshExecCredential } from '../../src/types'

function makeClient(overrides: Partial<Record<'getSshExecCredential', jest.Mock>> = {}): ApiClient {
  return {
    getSshExecCredential: overrides.getSshExecCredential ?? jest.fn(),
  } as unknown as ApiClient
}

const CREDENTIAL: SshExecCredential = {
  hostId: 'host-1',
  hostname: '203.0.113.10',
  port: 22,
  username: 'ubuntu',
  authType: 'key',
  privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-SECRET\n-----END OPENSSH PRIVATE KEY-----\n',
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('fetchSshExecCredential', () => {
  it('delegates to client.getSshExecCredential with commandId/agentId', async () => {
    const getSshExecCredential = jest.fn().mockResolvedValue(CREDENTIAL)
    const client = makeClient({ getSshExecCredential })

    const result = await fetchSshExecCredential(client, 'cmd-1', 'agent-1')

    expect(getSshExecCredential).toHaveBeenCalledWith('cmd-1', 'agent-1')
    expect(result).toEqual(CREDENTIAL)
  })

  it('passes through Tailscale SOCKS5 fields unchanged', async () => {
    const tailscaleCredential: SshExecCredential = {
      ...CREDENTIAL,
      connectionType: 'tailscale',
      tailnetHostname: 'db-server-1.tailxxxx.ts.net',
      socksPort: 1055,
    }
    const getSshExecCredential = jest.fn().mockResolvedValue(tailscaleCredential)
    const client = makeClient({ getSshExecCredential })

    const result = await fetchSshExecCredential(client, 'cmd-2', 'agent-1')

    expect(result.connectionType).toBe('tailscale')
    expect(result.tailnetHostname).toBe('db-server-1.tailxxxx.ts.net')
    expect(result.socksPort).toBe(1055)
  })

  it('wraps a fetch failure with context, without leaking the underlying error object', async () => {
    const getSshExecCredential = jest.fn().mockRejectedValue(new Error('404 not found'))
    const client = makeClient({ getSshExecCredential })

    await expect(fetchSshExecCredential(client, 'cmd-3', 'agent-1')).rejects.toThrow(
      'Failed to fetch SSH credential: 404 not found',
    )
  })

  it('never logs the resolved credential (private key / authkey)', async () => {
    const tailscaleCredential: SshExecCredential = {
      ...CREDENTIAL,
      tailscaleAuthKey: 'tskey-auth-FAKE-SECRET',
    }
    const getSshExecCredential = jest.fn().mockResolvedValue(tailscaleCredential)
    const client = makeClient({ getSshExecCredential })

    await fetchSshExecCredential(client, 'cmd-4', 'agent-1')

    const allLogCalls = [...mockLoggerDebug.mock.calls, ...mockLoggerError.mock.calls]
    const serialized = JSON.stringify(allLogCalls)
    expect(serialized).not.toContain('FAKE-SECRET')
    expect(serialized).not.toContain('tskey-auth-FAKE-SECRET')
  })
})
