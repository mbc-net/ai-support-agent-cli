/**
 * Tests for src/mcp/tools/db-ssm-tunnel.ts (`openSsmTunnel`).
 *
 * `child_process` (`spawn`) and `net` (`createServer` for local port
 * reservation + `Socket` for the port-readiness probe) are mocked the same way
 * db-tunnel.spec.ts mocks `ssh2`/`net`.
 *
 * Covers:
 *  (a) `aws ssm start-session` is spawned with the correct args
 *      (instanceId/host/portNumber/localPortNumber/region) and AWS credentials
 *      in env (sessionToken present and absent).
 *  (b) The local endpoint (127.0.0.1:<reservedPort>) is returned once the
 *      forwarded port accepts a TCP connection (after retrying).
 *  (c) A never-opening port times out, killing the subprocess.
 *  (d) An early subprocess exit / spawn error is propagated and kills nothing
 *      that is still alive.
 *  (e) `close()` SIGTERMs the subprocess, escalating to SIGKILL on grace expiry.
 *  (f) Validation of required fields.
 *  (g) awsCredentials are never passed to the logger.
 */

import { EventEmitter } from 'events'

import { SSM_KILL_GRACE_MS } from '../../../src/constants'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  // stderr is piped (stdio: ['ignore','ignore','pipe']) so the plugin's failure
  // reason can be surfaced; tests emit 'data' on it.
  stderr = new EventEmitter()
  // Default: SIGTERM/SIGKILL resolves the process asynchronously so killChild's
  // 'exit' listener fires without waiting on the grace timer. The SIGKILL
  // escalation test overrides this to a no-op.
  kill = jest.fn((signal?: NodeJS.Signals) => {
    setImmediate(() => {
      this.exitCode = signal === 'SIGKILL' ? null : 0
      this.signalCode = signal ?? 'SIGTERM'
      this.emit('exit', this.exitCode, this.signalCode)
    })
    return true
  })
}

let lastChild: FakeChild
const mockSpawn = jest.fn(() => {
  lastChild = new FakeChild()
  return lastChild
})
jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...(args as [])),
}))

// Local port reservation server.
class FakeServer extends EventEmitter {
  address = jest.fn<unknown, []>(() => ({ port: 15001 }))
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

// Sequence of outcomes each successive port-probe Socket should emit.
let socketOutcomes: Array<'connect' | 'error' | 'timeout'> = []
let socketIndex = 0
const createdSockets: FakeSocket[] = []

class FakeSocket extends EventEmitter {
  setTimeout = jest.fn()
  destroy = jest.fn()
  connect = jest.fn((_port: number, _host: string) => {
    const outcome = socketOutcomes[socketIndex] ?? 'error'
    socketIndex += 1
    setImmediate(() => this.emit(outcome))
    return this
  })
  constructor() {
    super()
    createdSockets.push(this)
  }
}

jest.mock('net', () => ({
  createServer: () => fakeServer,
  Socket: function (this: unknown) {
    return new FakeSocket()
  },
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

import { openSsmTunnel } from '../../../src/mcp/tools/db-ssm-tunnel'

const flush = () => new Promise((resolve) => setImmediate(resolve))

const ACCESS_KEY = 'AKIAFAKEACCESSKEY'
const SECRET_KEY = 'FAKE-SECRET-ACCESS-KEY-MATERIAL'
const SESSION_TOKEN = 'FAKE-SESSION-TOKEN-MATERIAL'

const TARGET = { host: 'db.internal', port: 3306 }

function params(overrides: Record<string, unknown> = {}) {
  return {
    instanceId: 'i-0abc123',
    region: 'ap-northeast-1',
    awsCredentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
    target: TARGET,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  fakeServer = new FakeServer()
  socketOutcomes = ['connect']
  socketIndex = 0
  createdSockets.length = 0
})

describe('openSsmTunnel', () => {
  it('spawns aws ssm start-session with the correct args and credential env', async () => {
    await openSsmTunnel(params({ awsCredentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, sessionToken: SESSION_TOKEN } }))

    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [cmd, args, opts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(cmd).toBe('aws')
    expect(args).toEqual([
      'ssm',
      'start-session',
      '--target',
      'i-0abc123',
      '--document-name',
      'AWS-StartPortForwardingSessionToRemoteHost',
      '--parameters',
      'host=db.internal,portNumber=3306,localPortNumber=15001',
      '--region',
      'ap-northeast-1',
    ])
    // stdin/stdout ignored (no forwarded data reaches logs); stderr piped for diagnostics.
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe'])
    const env = opts.env as Record<string, string>
    expect(env.AWS_ACCESS_KEY_ID).toBe(ACCESS_KEY)
    expect(env.AWS_SECRET_ACCESS_KEY).toBe(SECRET_KEY)
    expect(env.AWS_DEFAULT_REGION).toBe('ap-northeast-1')
    expect(env.AWS_SESSION_TOKEN).toBe(SESSION_TOKEN)
  })

  it('omits AWS_SESSION_TOKEN when no sessionToken is provided', async () => {
    await openSsmTunnel(params())
    const [, , opts] = mockSpawn.mock.calls[0] as [string, string[], Record<string, unknown>]
    const env = opts.env as Record<string, string>
    expect('AWS_SESSION_TOKEN' in env).toBe(false)
  })

  it('returns the reserved local endpoint once the port accepts a connection', async () => {
    const tunnel = await openSsmTunnel(params())
    expect(tunnel.host).toBe('127.0.0.1')
    expect(tunnel.port).toBe(15001)
  })

  it('retries the port probe until the forwarded port opens', async () => {
    socketOutcomes = ['error', 'timeout', 'connect']
    const tunnel = await openSsmTunnel(params())
    expect(tunnel.port).toBe(15001)
    // 3 probe sockets were created (2 failures + 1 success).
    expect(createdSockets.length).toBe(3)
  })

  it('times out and kills the subprocess when the port never opens', async () => {
    socketOutcomes = ['error', 'error', 'error', 'error', 'error']
    await expect(openSsmTunnel(params({ timeoutMs: 100 }))).rejects.toThrow(/Timed out waiting/)
    expect(lastChild.kill).toHaveBeenCalled()
  })

  it('rejects and does not hang when the subprocess exits before the port is ready', async () => {
    socketOutcomes = ['error', 'error', 'error']
    const promise = openSsmTunnel(params({ timeoutMs: 5_000 }))
    await flush()
    lastChild.exitCode = 1
    lastChild.emit('exit', 1, null)
    await expect(promise).rejects.toThrow(/exited before the port forward was ready/)
  })

  it('rejects when the subprocess fails to spawn', async () => {
    socketOutcomes = ['error', 'error']
    const promise = openSsmTunnel(params({ timeoutMs: 5_000 }))
    await flush()
    lastChild.emit('error', new Error('spawn aws ENOENT'))
    await expect(promise).rejects.toThrow(/spawn aws ENOENT/)
  })

  it('includes captured stderr in the error when the subprocess exits early', async () => {
    socketOutcomes = ['error', 'error', 'error']
    const promise = openSsmTunnel(params({ timeoutMs: 5_000 }))
    await flush()
    lastChild.stderr.emit('data', Buffer.from('TargetNotConnected: instance i-0abc123 is not connected'))
    lastChild.exitCode = 254
    lastChild.emit('exit', 254, null)
    await expect(promise).rejects.toThrow(/TargetNotConnected/)
  })

  it('caps retained stderr to the most recent bytes', async () => {
    socketOutcomes = ['error', 'error']
    const promise = openSsmTunnel(params({ timeoutMs: 5_000 }))
    await flush()
    // Emit far more than the cap; only the tail (with the real reason) is kept.
    lastChild.stderr.emit('data', 'x'.repeat(20_000))
    lastChild.stderr.emit('data', 'AccessDeniedException at the end')
    lastChild.exitCode = 1
    lastChild.emit('exit', 1, null)
    await expect(promise).rejects.toThrow(/AccessDeniedException at the end/)
  })

  it('logs (and does not crash) when the subprocess emits error after the port forward is established', async () => {
    const tunnel = await openSsmTunnel(params())
    // Node turns an 'error' event with no listener into a throw
    // (uncaughtException -> process.exit(1)). The permanent post-establishment
    // handler must absorb it: emit must NOT throw, and the reason is logged.
    expect(() => lastChild.emit('error', new Error('post-established boom'))).not.toThrow()
    expect(mockLoggerError).toHaveBeenCalled()
    const logged = mockLoggerError.mock.calls.flat().join(' ')
    expect(logged).toContain('post-established boom')
    await tunnel.close()
  })

  it('does not log AWS secret material via the post-establishment error handler', async () => {
    const tunnel = await openSsmTunnel(
      params({ awsCredentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, sessionToken: SESSION_TOKEN } }),
    )
    lastChild.emit('error', new Error('post-established boom'))
    const logged = mockLoggerError.mock.calls.flat().join(' ')
    expect(logged).not.toContain(SECRET_KEY)
    expect(logged).not.toContain(SESSION_TOKEN)
    expect(logged).not.toContain(ACCESS_KEY)
    await tunnel.close()
  })

  it('close() SIGTERMs the subprocess', async () => {
    const tunnel = await openSsmTunnel(params())
    await tunnel.close()
    expect(lastChild.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('close() escalates to SIGKILL when SIGTERM does not stop the process', async () => {
    const tunnel = await openSsmTunnel(params())
    // Make SIGTERM a no-op so the grace timer must escalate.
    lastChild.kill.mockImplementation(() => true)

    jest.useFakeTimers()
    try {
      const closePromise = tunnel.close()
      expect(lastChild.kill).toHaveBeenCalledWith('SIGTERM')
      jest.advanceTimersByTime(SSM_KILL_GRACE_MS)
      await closePromise
      expect(lastChild.kill).toHaveBeenCalledWith('SIGKILL')
    } finally {
      jest.useRealTimers()
    }
  })

  it('close() resolves immediately when the process has already exited', async () => {
    const tunnel = await openSsmTunnel(params())
    lastChild.exitCode = 0
    lastChild.kill.mockClear()
    await tunnel.close()
    expect(lastChild.kill).not.toHaveBeenCalled()
  })

  it('rejects when instanceId is missing', async () => {
    await expect(openSsmTunnel(params({ instanceId: '' }))).rejects.toThrow(/instanceId/)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('rejects when region is missing', async () => {
    await expect(openSsmTunnel(params({ region: '' }))).rejects.toThrow(/region/)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('rejects when awsCredentials are incomplete', async () => {
    await expect(
      openSsmTunnel(params({ awsCredentials: { accessKeyId: '', secretAccessKey: SECRET_KEY } })),
    ).rejects.toThrow(/awsCredentials/)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('rejects when the local port reservation server fails to listen', async () => {
    fakeServer.listen = jest.fn(() => {
      fakeServer.emit('error', new Error('EADDRINUSE'))
      return fakeServer
    }) as unknown as FakeServer['listen']

    await expect(openSsmTunnel(params())).rejects.toThrow('EADDRINUSE')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('rejects when the reserved local port address is unavailable', async () => {
    fakeServer.address = jest.fn(() => null) as unknown as FakeServer['address']

    await expect(openSsmTunnel(params())).rejects.toThrow(/local tunnel port/)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('never logs the AWS secret material', async () => {
    await openSsmTunnel(params({ awsCredentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, sessionToken: SESSION_TOKEN } }))
    const logged = mockLoggerDebug.mock.calls.flat().join(' ')
    expect(logged).not.toContain(SECRET_KEY)
    expect(logged).not.toContain(SESSION_TOKEN)
    expect(logged).not.toContain(ACCESS_KEY)
  })
})
