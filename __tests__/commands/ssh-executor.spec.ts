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
import { createHash } from 'crypto'

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

import { executeSshCommand, executeSshCommandStreaming } from '../../src/commands/ssh-executor'
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
    hostKeyFingerprint: `SHA256:${createHash('sha256').update('trusted-key').digest('base64').replace(/=+$/, '')}`,
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
  it('rejects missing pins before SSH or Tailscale network access', async () => {
    await expect(executeSshCommand(tailscaleCredential({ hostKeyFingerprint: undefined }), 'echo test')).rejects.toThrow('hostKeyFingerprint')
    expect(mockCreateConnection).not.toHaveBeenCalled()
    expect(mockClientCtor).not.toHaveBeenCalled()
  })

  describe('direct connection (no tailnetHostname)', () => {
    it('connects with host/port and no sock option', async () => {
      const promise = executeSshCommand(directCredential(), 'echo hi', 5)
      await completeExec(0, 'hi\n', '')
      await expect(promise).resolves.toBe('hi\n')

      expect(mockCreateConnection).not.toHaveBeenCalled()
      const connectConfig = lastClient!.connect.mock.calls[0][0]
      expect(connectConfig.hostVerifier).toEqual(expect.any(Function))
      expect(connectConfig.hostVerifier(Buffer.from('trusted-key'))).toBe(true)
      expect(connectConfig.hostVerifier(Buffer.from('attacker-key'))).toBe(false)
      expect(connectConfig.host).toBe('203.0.113.10')
      expect(connectConfig.port).toBe(22)
      expect(connectConfig.sock).toBeUndefined()
    })

    it('does not restrict host key algorithms by default', async () => {
      const promise = executeSshCommand(directCredential(), 'echo hi', 5)
      await completeExec(0, 'hi\n', '')
      await promise
      expect(lastClient!.connect.mock.calls[0][0].algorithms).toBeUndefined()
    })

    it('restricts negotiation to the pinned key type when hostKeyAlgorithms is given', async () => {
      const promise = executeSshCommand(directCredential(), 'echo hi', 5, { hostKeyAlgorithms: ['ssh-ed25519'] })
      await completeExec(0, 'hi\n', '')
      await promise
      expect(lastClient!.connect.mock.calls[0][0].algorithms).toEqual({ serverHostKey: ['ssh-ed25519'] })
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

describe('executeSshCommandStreaming', () => {
  async function openStream(): Promise<FakeSshStream> {
    await flush()
    const client = lastClient!
    client.emit('ready')
    await flush()
    const stream = new FakeSshStream()
    const execCallback = client.exec.mock.calls[0][1] as (err: Error | null, stream: FakeSshStream) => void
    execCallback(null, stream)
    return stream
  }

  it('delivers complete lines across chunk boundaries and the final unterminated line', async () => {
    const lines: string[] = []
    const promise = executeSshCommandStreaming(directCredential(), 'gzip -dc -- /var/log/a.gz', 5, {
      onLine: (l) => lines.push(l),
      maxBytes: 1000,
    })
    const stream = await openStream()
    stream.emit('data', Buffer.from('one\ntw'))
    stream.emit('data', Buffer.from('o\nthr'))
    stream.emit('data', Buffer.from('ee'))
    stream.emit('close', 0)
    await expect(promise).resolves.toEqual({ exitCode: 0, stderr: '', truncated: false })
    expect(lines).toEqual(['one', 'two', 'three'])
    expect(lastClient!.end).toHaveBeenCalled()
  })

  it('never splits a multibyte character across chunks', async () => {
    const lines: string[] = []
    const promise = executeSshCommandStreaming(directCredential(), 'x', 5, { onLine: (l) => lines.push(l), maxBytes: 1000 })
    const stream = await openStream()
    const bytes = Buffer.from('ログ\n')
    stream.emit('data', bytes.subarray(0, 2))
    stream.emit('data', bytes.subarray(2))
    stream.emit('close', 0)
    await promise
    expect(lines).toEqual(['ログ'])
  })

  it('reports the exit code and (capped) stderr', async () => {
    const promise = executeSshCommandStreaming(directCredential(), 'grep', 5, { onLine: () => undefined, maxBytes: 1000 })
    const stream = await openStream()
    stream.stderr.emit('data', Buffer.from('e'.repeat(5000)))
    stream.emit('close', 2)
    const result = await promise
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toHaveLength(4096)
    expect(result.truncated).toBe(false)
  })

  it('stops reading at maxBytes, drops the partial line, and marks truncated', async () => {
    const lines: string[] = []
    const promise = executeSshCommandStreaming(directCredential(), 'x', 5, { onLine: (l) => lines.push(l), maxBytes: 10 })
    const stream = await openStream()
    stream.emit('data', Buffer.from('aaaa\nbbbb\ncccc\n'))
    stream.emit('data', Buffer.from('dddd\n'))
    stream.emit('close', 0)
    await expect(promise).resolves.toEqual({ exitCode: null, stderr: '', truncated: true })
    expect(lines).toEqual(['aaaa', 'bbbb'])
    expect(lastClient!.end).toHaveBeenCalled()
  })

  it('caps a single very long line instead of buffering it whole', async () => {
    const lines: string[] = []
    const promise = executeSshCommandStreaming(directCredential(), 'x', 5, {
      onLine: (l) => lines.push(l),
      maxBytes: 1000,
      maxLineBytes: 8,
    })
    const stream = await openStream()
    stream.emit('data', Buffer.from('0123456789'))
    stream.emit('data', Buffer.from('abc\nok\n'))
    stream.emit('close', 0)
    await promise
    expect(lines).toEqual(['01234567', 'ok'])
  })

  it('rejects when the line callback throws', async () => {
    const promise = executeSshCommandStreaming(directCredential(), 'x', 5, {
      onLine: () => {
        throw new Error('callback failed')
      },
      maxBytes: 1000,
    })
    const stream = await openStream()
    stream.emit('data', Buffer.from('a\n'))
    await expect(promise).rejects.toThrow('callback failed')
  })

  it('passes hostKeyAlgorithms and uses the pinned host verifier', async () => {
    const promise = executeSshCommandStreaming(directCredential(), 'x', 5, {
      onLine: () => undefined,
      maxBytes: 10,
      hostKeyAlgorithms: ['ssh-ed25519'],
    })
    const stream = await openStream()
    stream.emit('close', 0)
    await promise
    const connectConfig = lastClient!.connect.mock.calls[0][0]
    expect(connectConfig.algorithms).toEqual({ serverHostKey: ['ssh-ed25519'] })
    expect(connectConfig.hostVerifier(Buffer.from('attacker-key'))).toBe(false)
    expect(lastClient!.exec.mock.calls[0][0]).toBe('x')
  })

  it('rejects missing pins before connecting', async () => {
    await expect(
      executeSshCommandStreaming(directCredential({ hostKeyFingerprint: undefined }), 'x', 5, { onLine: () => undefined, maxBytes: 1 }),
    ).rejects.toThrow('hostKeyFingerprint')
    expect(mockClientCtor).not.toHaveBeenCalled()
  })

  it('rejects on connection and exec errors', async () => {
    const p1 = executeSshCommandStreaming(directCredential(), 'x', 5, { onLine: () => undefined, maxBytes: 1 })
    await flush()
    lastClient!.emit('error', new Error('ECONNREFUSED'))
    await expect(p1).rejects.toThrow('ECONNREFUSED')

    const p2 = executeSshCommandStreaming(directCredential(), 'x', 5, { onLine: () => undefined, maxBytes: 1 })
    await flush()
    lastClient!.emit('ready')
    await flush()
    ;(lastClient!.exec.mock.calls[0][1] as (err: Error | null) => void)(new Error('exec failed'))
    await expect(p2).rejects.toThrow('exec failed')
  })

  describe('timeout', () => {
    beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }))
    afterEach(() => jest.useRealTimers())

    it('rejects and ends the connection after the timeout', async () => {
      const promise = executeSshCommandStreaming(directCredential(), 'x', 2, { onLine: () => undefined, maxBytes: 10 })
      await openStream()
      jest.advanceTimersByTime(2000)
      await expect(promise).rejects.toThrow(/timed out/i)
      expect(lastClient!.end).toHaveBeenCalled()
    })
  })
})
