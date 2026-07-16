/**
 * Tests for src/commands/ssh-executor.ts.
 *
 * Covers:
 *  (a) SOCKS5 routing: when the credential carries `tailnetHostname`, a
 *      SOCKS5 socket is created via the `socks` package and handed to
 *      ssh2's `Client.connect({ sock })`.
 *  (b) Direct connection: without `tailnetHostname`, ssh2 connects with
 *      `host`/`port` and no `sock`.
 *  (c) Timeout handling and exit-code formatting (ported from
 *      api/src/llm/tools/ssh.tool.ts's `executeViaSsh`).
 *  (d) The private key / password is never passed to the logger.
 *
 * `ssh2` and `socks` are loaded via dynamic `import()` inside
 * ssh-executor.ts; jest.mock intercepts the underlying `require` the same
 * way regardless of static/dynamic import (see db-query.spec.ts's
 * `jest.mock('mysql2/promise', ...)` for the established pattern in this
 * repo).
 */

import { EventEmitter } from 'events'

class FakeSshStream extends EventEmitter {
  stderr = new EventEmitter()
}

class FakeSshClient extends EventEmitter {
  connect = jest.fn()
  end = jest.fn()
  exec = jest.fn()
}

let lastClient: FakeSshClient | null = null
const mockClientCtor = jest.fn().mockImplementation(function (this: unknown) {
  lastClient = new FakeSshClient()
  return lastClient
})
jest.mock('ssh2', () => ({
  Client: function (this: unknown, ...args: unknown[]) {
    return mockClientCtor(...args)
  },
}))

const mockCreateConnection = jest.fn()
jest.mock('socks', () => ({
  SocksClient: {
    createConnection: (...args: unknown[]) => mockCreateConnection(...args),
  },
}))

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

import { executeSshCommand } from '../../src/commands/ssh-executor'
import type { SshExecCredential } from '../../src/types'

const flush = () => new Promise((resolve) => setImmediate(resolve))

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-SECRET-KEY-MATERIAL\n-----END OPENSSH PRIVATE KEY-----\n'

function directCredential(overrides: Partial<SshExecCredential> = {}): SshExecCredential {
  return {
    hostId: 'host-1',
    hostname: '203.0.113.10',
    port: 22,
    username: 'ubuntu',
    // Mirrors the real api enum (api/src/project/dto/ssh-config.dto.ts:
    // `enum: ['password', 'privateKey']`).
    authType: 'privateKey',
    privateKey: PRIVATE_KEY,
    ...overrides,
  }
}

function tailscaleCredential(overrides: Partial<SshExecCredential> = {}): SshExecCredential {
  return directCredential({
    connectionType: 'tailscale',
    tailnetHostname: 'db-server-1.tailxxxx.ts.net',
    socksPort: 1055,
    tailscaleAuthKey: 'tskey-auth-FAKE-SECRET',
    ...overrides,
  })
}

async function completeExec(code: number, stdout: string, stderr: string): Promise<void> {
  await flush()
  const client = lastClient!
  client.emit('ready')
  await flush()
  const stream = new FakeSshStream()
  const execCallback = client.exec.mock.calls[0][1] as (err: Error | null, stream: FakeSshStream) => void
  execCallback(null, stream)
  if (stdout) stream.emit('data', Buffer.from(stdout))
  if (stderr) stream.stderr.emit('data', Buffer.from(stderr))
  stream.emit('close', code)
}

beforeEach(() => {
  jest.clearAllMocks()
  lastClient = null
})

describe('executeSshCommand', () => {
  describe('direct connection (no tailnetHostname)', () => {
    it('connects with host/port and no sock option', async () => {
      const promise = executeSshCommand(directCredential(), 'echo hi', 5)
      await completeExec(0, 'hi\n', '')
      await expect(promise).resolves.toBe('hi\n')

      expect(mockCreateConnection).not.toHaveBeenCalled()
      const connectConfig = lastClient!.connect.mock.calls[0][0]
      expect(connectConfig.host).toBe('203.0.113.10')
      expect(connectConfig.port).toBe(22)
      expect(connectConfig.sock).toBeUndefined()
    })

    it('defaults to port 22 when credential.port is falsy', async () => {
      const promise = executeSshCommand(directCredential({ port: 0 }), 'echo hi', 5)
      await completeExec(0, 'hi\n', '')
      await promise
      expect(lastClient!.connect.mock.calls[0][0].port).toBe(22)
    })

    it('uses password auth when authType is password', async () => {
      const promise = executeSshCommand(
        directCredential({ authType: 'password', privateKey: 'super-secret-password' }),
        'echo hi',
        5,
      )
      await completeExec(0, 'hi\n', '')
      await promise
      const connectConfig = lastClient!.connect.mock.calls[0][0]
      expect(connectConfig.password).toBe('super-secret-password')
      expect(connectConfig.privateKey).toBeUndefined()
    })
  })

  describe('Tailscale SOCKS5 connection', () => {
    it('creates a SOCKS5 socket via the socks package and passes it as sock', async () => {
      const fakeSocket = { fake: 'socket' }
      mockCreateConnection.mockResolvedValue({ socket: fakeSocket })

      const promise = executeSshCommand(tailscaleCredential(), 'echo hi', 5)
      await completeExec(0, 'hi\n', '')
      await promise

      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          proxy: expect.objectContaining({ host: '127.0.0.1', port: 1055, type: 5 }),
          command: 'connect',
          destination: expect.objectContaining({
            host: 'db-server-1.tailxxxx.ts.net',
            port: 22,
          }),
        }),
      )

      const connectConfig = lastClient!.connect.mock.calls[0][0]
      expect(connectConfig.sock).toBe(fakeSocket)
      expect(connectConfig.host).toBeUndefined()
      expect(connectConfig.port).toBeUndefined()
    })

    it('defaults socksPort to 1055 when not specified', async () => {
      mockCreateConnection.mockResolvedValue({ socket: {} })
      const credential = tailscaleCredential()
      delete credential.socksPort

      const promise = executeSshCommand(credential, 'echo hi', 5)
      await completeExec(0, '', '')
      await promise

      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({ proxy: expect.objectContaining({ port: 1055 }) }),
      )
    })

    it('rejects without attempting a direct fallback when tailnetHostname is missing', async () => {
      const credential = tailscaleCredential()
      delete credential.tailnetHostname

      await expect(executeSshCommand(credential, 'echo hi', 5)).rejects.toThrow('tailnetHostname')
      expect(mockClientCtor).not.toHaveBeenCalled()
    })

    it('rejects without a direct fallback when the SOCKS5 connection fails', async () => {
      mockCreateConnection.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:1055'))

      await expect(executeSshCommand(tailscaleCredential(), 'echo hi', 5)).rejects.toThrow(
        /Tailscale SOCKS5/,
      )
      // No ssh2 Client should have been constructed/connected once the SOCKS5 hop failed.
      expect(mockClientCtor).not.toHaveBeenCalled()
    })
  })

  describe('exit code formatting', () => {
    it('returns plain stdout on a clean (0) exit', async () => {
      const promise = executeSshCommand(directCredential(), 'echo hi', 5)
      await completeExec(0, 'clean output\n', '')
      await expect(promise).resolves.toBe('clean output\n')
    })

    it('formats an Exit code block when exit is non-zero and stderr is present', async () => {
      const promise = executeSshCommand(directCredential(), 'false', 5)
      await completeExec(1, 'partial out\n', 'boom\n')
      await expect(promise).resolves.toBe('Exit code: 1\nSTDOUT:\npartial out\n\nSTDERR:\nboom\n')
    })

    it('formats an Exit code block (without a STDERR section) when exit is non-zero but stderr is empty', async () => {
      const promise = executeSshCommand(directCredential(), 'exit 2', 5)
      await completeExec(2, 'some output\n', '')
      await expect(promise).resolves.toBe('Exit code: 2\nSTDOUT:\nsome output\n')
    })
  })

  describe('timeout handling', () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }))
    afterEach(() => jest.useRealTimers())

    it('rejects and ends the connection when the command exceeds the timeout', async () => {
      const promise = executeSshCommand(directCredential(), 'sleep 999', 2)
      await flush()
      lastClient!.emit('ready')
      await flush()

      jest.advanceTimersByTime(2000)

      await expect(promise).rejects.toThrow(/timed out/i)
      expect(lastClient!.end).toHaveBeenCalled()
    })
  })

  describe('connection errors', () => {
    it('rejects when ssh2 emits an error event', async () => {
      const promise = executeSshCommand(directCredential(), 'echo hi', 5)
      await flush()
      lastClient!.emit('error', new Error('ECONNREFUSED'))
      await expect(promise).rejects.toThrow('ECONNREFUSED')
    })

    it('rejects when ssh2 exec() itself errors', async () => {
      const promise = executeSshCommand(directCredential(), 'echo hi', 5)
      await flush()
      lastClient!.emit('ready')
      await flush()
      const execCallback = lastClient!.exec.mock.calls[0][1] as (err: Error | null) => void
      execCallback(new Error('exec failed'))
      await expect(promise).rejects.toThrow('exec failed')
    })
  })

  describe('input validation', () => {
    it('rejects when hostname/username/authType are missing', async () => {
      await expect(
        executeSshCommand({ ...directCredential(), hostname: '' }, 'echo hi', 5),
      ).rejects.toThrow(/hostname/)
      expect(mockClientCtor).not.toHaveBeenCalled()
    })

    // Regression: server-setup-runner.ts's validateSshCredential rejects an
    // authType that isn't 'password'/'privateKey' rather than silently
    // falling back to the key path (フォールバック禁止) — an unrecognized
    // authType here must not fall back to treating credential.privateKey
    // (which could be anything) as SSH key material either.
    it('rejects an unsupported authType instead of falling back to key auth', async () => {
      await expect(
        executeSshCommand(directCredential({ authType: 'kerberos' }), 'echo hi', 5),
      ).rejects.toThrow(/authType/)
      expect(mockClientCtor).not.toHaveBeenCalled()
    })
  })

  describe('secret non-exposure', () => {
    it('never logs the private key / password', async () => {
      const promise = executeSshCommand(directCredential(), 'echo hi', 5)
      await completeExec(0, 'hi\n', '')
      await promise

      const allLogCalls = [...mockLoggerDebug.mock.calls, ...mockLoggerError.mock.calls]
      const serialized = JSON.stringify(allLogCalls)
      expect(serialized).not.toContain('FAKE-SECRET-KEY-MATERIAL')
    })

    it('never logs the Tailscale authkey', async () => {
      mockCreateConnection.mockResolvedValue({ socket: {} })
      const promise = executeSshCommand(tailscaleCredential(), 'echo hi', 5)
      await completeExec(0, 'hi\n', '')
      await promise

      const allLogCalls = [...mockLoggerDebug.mock.calls, ...mockLoggerError.mock.calls]
      const serialized = JSON.stringify(allLogCalls)
      expect(serialized).not.toContain('tskey-auth-FAKE-SECRET')
    })
  })
})
