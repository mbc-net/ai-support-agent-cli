/**
 * Tests for src/mcp/tools/db-tunnel.ts (`openSshTunnel`).
 *
 * `ssh2` (dynamic import) and `net` (static import) are mocked the same way
 * db-query.spec.ts mocks `mysql2`/`pg` and ssh-executor.spec.ts mocks `ssh2`.
 *
 * Covers:
 *  (a) SSH client connects with hostname/port and password vs privateKey auth.
 *  (b) A local TCP server is opened on an ephemeral port and its port is
 *      returned as the tunnel endpoint (127.0.0.1:<localPort>).
 *  (c) Each accepted local socket is forwarded to the target host/port via
 *      `conn.forwardOut` and piped both ways; a forwardOut error destroys the
 *      local socket.
 *  (d) `close()` shuts down the server and ends the SSH connection.
 *  (e) Validation / error propagation: missing fields, unsupported authType,
 *      SSH connect error, server listen error, missing address info.
 *  (f) The private key / password is never passed to the logger.
 */

import { EventEmitter } from 'events'

class FakeSshClient extends EventEmitter {
  connect = jest.fn()
  end = jest.fn()
  forwardOut = jest.fn()
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

class FakeServer extends EventEmitter {
  address = jest.fn<unknown, []>(() => ({ port: 15000 }))
  close = jest.fn((cb?: () => void) => {
    if (cb) cb()
    return this
  })
  listen = jest.fn((_port: number, _host: string, cb: () => void) => {
    cb()
    return this
  })
}

let fakeServer: FakeServer
let connectionHandler: ((socket: unknown) => void) | undefined
const mockCreateServer = jest.fn()
jest.mock('net', () => ({
  createServer: (...args: unknown[]) => mockCreateServer(...args),
}))

const mockLoggerDebug = jest.fn()
const mockLoggerError = jest.fn()
jest.mock('../../../src/logger', () => ({
  logger: {
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    info: jest.fn(),
    warn: jest.fn(),
    success: jest.fn(),
  },
}))

import { openSshTunnel } from '../../../src/mcp/tools/db-tunnel'
import type { SshCredentials } from '../../../src/types'

const flush = () => new Promise((resolve) => setImmediate(resolve))

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-SECRET-KEY-MATERIAL\n-----END OPENSSH PRIVATE KEY-----\n'

function sshCredential(overrides: Partial<SshCredentials> = {}): SshCredentials {
  return {
    hostId: 'host-1',
    hostname: '203.0.113.10',
    port: 22,
    username: 'ubuntu',
    authType: 'privateKey',
    privateKey: PRIVATE_KEY,
    ...overrides,
  }
}

const TARGET = { host: 'db.internal', port: 3306 }

beforeEach(() => {
  jest.clearAllMocks()
  lastClient = null
  connectionHandler = undefined
  fakeServer = new FakeServer()
  mockCreateServer.mockImplementation((handler: (socket: unknown) => void) => {
    connectionHandler = handler
    return fakeServer
  })
})

/** Drive openSshTunnel to a resolved tunnel by emitting the SSH 'ready' event. */
async function openReady(ssh: SshCredentials = sshCredential()) {
  const promise = openSshTunnel(ssh, TARGET)
  await flush()
  lastClient!.emit('ready')
  return promise
}

describe('openSshTunnel', () => {
  it('connects the SSH client with hostname/port and privateKey auth', async () => {
    await openReady()
    const connectConfig = lastClient!.connect.mock.calls[0][0]
    expect(connectConfig.host).toBe('203.0.113.10')
    expect(connectConfig.port).toBe(22)
    expect(connectConfig.username).toBe('ubuntu')
    expect(connectConfig.privateKey).toBe(PRIVATE_KEY)
    expect(connectConfig.password).toBeUndefined()
  })

  it('uses password auth when authType is password', async () => {
    await openReady(sshCredential({ authType: 'password', privateKey: 'super-secret-password' }))
    const connectConfig = lastClient!.connect.mock.calls[0][0]
    expect(connectConfig.password).toBe('super-secret-password')
    expect(connectConfig.privateKey).toBeUndefined()
  })

  it('defaults SSH port to 22 when credential.port is falsy', async () => {
    await openReady(sshCredential({ port: 0 }))
    expect(lastClient!.connect.mock.calls[0][0].port).toBe(22)
  })

  it('returns the local ephemeral endpoint from the listening server', async () => {
    const tunnel = await openReady()
    expect(mockCreateServer).toHaveBeenCalled()
    expect(fakeServer.listen).toHaveBeenCalledWith(0, '127.0.0.1', expect.any(Function))
    expect(tunnel.host).toBe('127.0.0.1')
    expect(tunnel.port).toBe(15000)
  })

  /** A local socket / SSH stream fake that records 'error' listeners so tests can fire them. */
  function makePipePair() {
    const streamHandlers: Record<string, (err: Error) => void> = {}
    const socketHandlers: Record<string, (err: Error) => void> = {}
    const fakeStream = {
      pipe: jest.fn((dest: unknown) => dest),
      destroy: jest.fn(),
      on: jest.fn((event: string, cb: (err: Error) => void) => {
        streamHandlers[event] = cb
      }),
    }
    const socket = {
      pipe: jest.fn((dest: unknown) => dest),
      destroy: jest.fn(),
      on: jest.fn((event: string, cb: (err: Error) => void) => {
        socketHandlers[event] = cb
      }),
    }
    return { fakeStream, socket, streamHandlers, socketHandlers }
  }

  it('forwards accepted local sockets to the target and pipes both directions', async () => {
    await openReady()
    const { fakeStream, socket } = makePipePair()
    lastClient!.forwardOut.mockImplementation(
      (_sh: string, _sp: number, _dh: string, _dp: number, cb: (err: Error | null, stream: unknown) => void) => {
        cb(null, fakeStream)
      },
    )

    connectionHandler!(socket)

    expect(lastClient!.forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      expect.any(Number),
      'db.internal',
      3306,
      expect.any(Function),
    )
    expect(socket.pipe).toHaveBeenCalledWith(fakeStream)
    expect(fakeStream.pipe).toHaveBeenCalledWith(socket)
    expect(socket.destroy).not.toHaveBeenCalled()
    // 'error' listeners are registered on both ends so a mid-stream failure
    // cannot become an uncaughtException that crashes the process.
    expect(socket.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(fakeStream.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('tears down only the affected connection (not the process) on a local socket error', async () => {
    await openReady()
    const { fakeStream, socket, socketHandlers } = makePipePair()
    lastClient!.forwardOut.mockImplementation(
      (_sh: string, _sp: number, _dh: string, _dp: number, cb: (err: Error | null, stream: unknown) => void) => {
        cb(null, fakeStream)
      },
    )
    connectionHandler!(socket)

    // Firing the recorded 'error' handler must not throw (i.e. not propagate as
    // an uncaughtException) and must destroy both ends of just this connection.
    expect(() => socketHandlers.error(new Error('ECONNRESET'))).not.toThrow()
    expect(socket.destroy).toHaveBeenCalled()
    expect(fakeStream.destroy).toHaveBeenCalled()
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('db.internal:3306'))
  })

  it('tears down only the affected connection on an SSH stream error', async () => {
    await openReady()
    const { fakeStream, socket, streamHandlers } = makePipePair()
    lastClient!.forwardOut.mockImplementation(
      (_sh: string, _sp: number, _dh: string, _dp: number, cb: (err: Error | null, stream: unknown) => void) => {
        cb(null, fakeStream)
      },
    )
    connectionHandler!(socket)

    expect(() => streamHandlers.error(new Error('channel EOF'))).not.toThrow()
    expect(socket.destroy).toHaveBeenCalled()
    expect(fakeStream.destroy).toHaveBeenCalled()
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining('channel EOF'))
  })

  it('destroys the local socket and logs when forwardOut fails', async () => {
    await openReady()
    lastClient!.forwardOut.mockImplementation(
      (_sh: string, _sp: number, _dh: string, _dp: number, cb: (err: Error | null, stream: unknown) => void) => {
        cb(new Error('channel open failure'), undefined)
      },
    )
    const socket = { pipe: jest.fn(), destroy: jest.fn(), on: jest.fn() }

    connectionHandler!(socket)

    expect(socket.destroy).toHaveBeenCalled()
    expect(socket.pipe).not.toHaveBeenCalled()
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to open forward channel to db.internal:3306'),
    )
  })

  it('close() shuts down the server and ends the SSH connection', async () => {
    const tunnel = await openReady()
    await tunnel.close()
    expect(fakeServer.close).toHaveBeenCalled()
    expect(lastClient!.end).toHaveBeenCalled()
  })

  it('rejects when hostname is missing', async () => {
    await expect(openSshTunnel(sshCredential({ hostname: '' }), TARGET)).rejects.toThrow(
      /hostname, username, and authType/,
    )
    expect(mockClientCtor).not.toHaveBeenCalled()
  })

  it('rejects when authType is not supported', async () => {
    await expect(
      openSshTunnel(sshCredential({ authType: 'keyboard-interactive' }), TARGET),
    ).rejects.toThrow(/authType is not supported/)
    expect(mockClientCtor).not.toHaveBeenCalled()
  })

  it('propagates SSH connection errors', async () => {
    const promise = openSshTunnel(sshCredential(), TARGET)
    await flush()
    lastClient!.emit('error', new Error('All authentication methods failed'))
    await expect(promise).rejects.toThrow('All authentication methods failed')
  })

  it('sets SSH keepalive options on connect', async () => {
    await openReady()
    const connectConfig = lastClient!.connect.mock.calls[0][0]
    expect(connectConfig.keepaliveInterval).toBeGreaterThan(0)
    expect(connectConfig.keepaliveCountMax).toBeGreaterThan(0)
  })

  it('logs (does not reject/crash) on an SSH error after the tunnel is established', async () => {
    await openReady()
    // The initial reject handler must have been removed; a post-ready error is
    // logged by the permanent handler rather than rejecting or crashing.
    expect(() => lastClient!.emit('error', new Error('bastion dropped connection'))).not.toThrow()
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining('SSH connection error after tunnel established'),
    )
  })

  it('ends the SSH connection when the local server fails to listen', async () => {
    fakeServer.listen = jest.fn(() => {
      fakeServer.emit('error', new Error('EADDRINUSE'))
      return fakeServer
    }) as unknown as FakeServer['listen']

    const promise = openSshTunnel(sshCredential(), TARGET)
    await flush()
    lastClient!.emit('ready')
    await expect(promise).rejects.toThrow('EADDRINUSE')
    // The already-established SSH connection must be ended so bind failures
    // cannot leak bastion sessions in the long-lived process.
    expect(lastClient!.end).toHaveBeenCalled()
  })

  it('ends the SSH connection when the server address is not available', async () => {
    fakeServer.address = jest.fn(() => null) as unknown as FakeServer['address']

    const promise = openSshTunnel(sshCredential(), TARGET)
    await flush()
    lastClient!.emit('ready')
    await expect(promise).rejects.toThrow(/local tunnel port/)
    expect(lastClient!.end).toHaveBeenCalled()
  })

  it('never logs the private key material', async () => {
    await openReady()
    const logged = mockLoggerDebug.mock.calls.flat().join(' ')
    expect(logged).not.toContain('FAKE-SECRET-KEY-MATERIAL')
  })
})
