/**
 * Tests for src/docker/project-image-builder.ts
 *
 * Covers buildProjectImage: log streaming, log truncation, error handling,
 * apiClient optional path, and agentId defaulting.
 */

import { EventEmitter } from 'events'

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  getProjectColor: jest.fn().mockReturnValue('\x1b[36m'),
  // Capture writes in memory instead of forwarding to the SUT's real write
  // callback (process.stdout.write). Writing through to (or spying on)
  // process.stdout.write inside a test interferes with Jest's own reporter and
  // hangs the Jest worker on CI.
  makeLinePrefixer: jest.fn().mockImplementation(
    (_prefix: string, _write: (s: string) => void) => (chunk: string) => {
      mockPrefixerWrites.push(chunk)
    },
  ),
}))

/** In-memory capture of everything the line-prefixer would have written. */
const mockPrefixerWrites: string[] = []

jest.mock('../../src/docker/dockerfile-path', () => ({
  getProjectImageTag: jest.fn(
    (tenantCode: string, projectCode: string, version: string) =>
      `ai-support-agent-${tenantCode}-${projectCode}:${version}`,
  ),
  getDockerContextDir: jest.fn().mockReturnValue('/mock/context'),
}))

jest.mock('../../src/docker/dockerfile-generator', () => ({
  buildDockerEnv: jest.fn().mockReturnValue({}),
}))

jest.mock('../../src/docker/docker-utils', () => ({
  makeSessionId: jest.fn().mockReturnValue('20260101000000'),
  getDockerPath: jest.fn().mockReturnValue('docker'),
}))

import { spawn } from 'child_process'
import { logger } from '../../src/logger'
import { buildProjectImage } from '../../src/docker/project-image-builder'

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>

/**
 * Create a fake process that behaves like a child_process result.
 */
function makeFakeProc(): EventEmitter & {
  stdout: EventEmitter & { on: jest.Mock }
  stderr: EventEmitter & { on: jest.Mock }
  kill: jest.Mock
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { on: jest.Mock }
    stderr: EventEmitter & { on: jest.Mock }
    kill: jest.Mock
  }
  proc.kill = jest.fn()
  proc.stdout = Object.assign(new EventEmitter(), {
    on: jest.fn().mockImplementation((...args: Parameters<EventEmitter['on']>) => {
      EventEmitter.prototype.on.apply(proc.stdout, args)
      return proc.stdout
    }),
  })
  proc.stderr = Object.assign(new EventEmitter(), {
    on: jest.fn().mockImplementation((...args: Parameters<EventEmitter['on']>) => {
      EventEmitter.prototype.on.apply(proc.stderr, args)
      return proc.stderr
    }),
  })
  return proc
}

describe('buildProjectImage', () => {
  const mockApiClient = {
    submitLogChunk: jest.fn().mockResolvedValue(undefined),
    saveSessionLog: jest.fn().mockResolvedValue(undefined),
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockPrefixerWrites.length = 0
  })

  it('builds image successfully and logs success', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile', mockApiClient as never, 'agent-1')

    await new Promise((r) => setImmediate(r))

    proc.emit('close', 0)
    await promise

    expect(logger.success).toHaveBeenCalledWith(
      expect.stringContaining('ai-support-agent-mbc-PROJ_A:1.0.0'),
    )
  })

  it('streams stdout data to apiClient as log chunks', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile', mockApiClient as never, 'agent-1')

    await new Promise((r) => setImmediate(r))

    // Emit a large chunk (> 4096 bytes) to trigger early flush
    const largeChunk = 'x'.repeat(5000)
    proc.stdout.emit('data', Buffer.from(largeChunk))

    // Allow the void flush() to settle
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    proc.emit('close', 0)
    await promise

    expect(mockApiClient.submitLogChunk).toHaveBeenCalled()
  })

  it('streams stderr data to apiClient', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile', mockApiClient as never, 'agent-1')

    await new Promise((r) => setImmediate(r))

    proc.stderr.emit('data', Buffer.from('some stderr line\n'))

    proc.emit('close', 0)
    await promise

    // Flush happens at the end
    expect(mockApiClient.submitLogChunk).toHaveBeenCalled()
  })

  it('calls saveSessionLog with accumulated log after successful build', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile', mockApiClient as never, 'agent-1')

    await new Promise((r) => setImmediate(r))

    proc.stdout.emit('data', Buffer.from('build step 1\n'))
    proc.emit('close', 0)

    await promise

    expect(mockApiClient.saveSessionLog).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent-1',
        projectCode: 'PROJ_A',
        logType: 'docker-build',
        content: expect.stringContaining('build step 1'),
      }),
    )
  })

  it('uses empty string for agentId when agentId is not provided', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    // No agentId passed — should default to '' (line 60: agentId ?? '')
    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile', mockApiClient as never)

    await new Promise((r) => setImmediate(r))

    proc.stdout.emit('data', Buffer.from('some output\n'))
    proc.emit('close', 0)

    await promise

    expect(mockApiClient.submitLogChunk).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: '' }),
    )
    expect(mockApiClient.saveSessionLog).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: '' }),
    )
  })

  it('throws error when docker build exits with non-zero code', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile')

    await new Promise((r) => setImmediate(r))

    proc.emit('close', 1)

    await expect(promise).rejects.toThrow('docker build exited with code 1')
  })

  it('throws error when spawn emits an error event', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile')

    await new Promise((r) => setImmediate(r))

    proc.emit('error', new Error('ENOENT'))

    await expect(promise).rejects.toThrow('ENOENT')
  })

  it('wraps non-Error throw in Error (line 89: non-Error branch)', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile')

    await new Promise((r) => setImmediate(r))

    // Simulate a non-Error rejection (string)
    // We can do this by emitting 'close' with code after an error path
    // The non-Error branch is triggered by catch in the Promise wrap
    // Since spawn.emit('error') always yields an Error, we simulate via
    // the reject callback in the Promise with a non-Error
    proc.emit('error', 'string-error' as never)

    await expect(promise).rejects.toThrow('string-error')
  })

  it('does not call apiClient when no apiClient is provided', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    // No apiClient passed — submitLogChunk/saveSessionLog should not be called
    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile')

    await new Promise((r) => setImmediate(r))

    proc.stdout.emit('data', Buffer.from('some output\n'))
    proc.emit('close', 0)

    await promise

    expect(mockApiClient.submitLogChunk).not.toHaveBeenCalled()
    expect(mockApiClient.saveSessionLog).not.toHaveBeenCalled()
    expect(logger.success).toHaveBeenCalled()
  })

  it('handles log truncation when output exceeds 2 MB limit', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile', mockApiClient as never, 'agent-1')

    await new Promise((r) => setImmediate(r))

    // Emit 2.5 MB of data to exceed the 2 MB limit and trigger truncation
    const chunkSize = 512 * 1024 // 512 KB
    const chunk = 'a'.repeat(chunkSize)
    // Send 5 chunks = 2.5 MB total; triggers truncation after the 4th flush
    for (let i = 0; i < 5; i++) {
      proc.stdout.emit('data', Buffer.from(chunk))
      // Each chunk > 4096 bytes triggers void flush(); allow it to settle
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    }

    proc.emit('close', 0)
    await promise

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Build log exceeded 2 MB limit'),
    )
  })

  it('handles log truncation when fullLog is already at max and remaining is zero', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile', mockApiClient as never, 'agent-1')

    await new Promise((r) => setImmediate(r))

    // Fill fullLog to exactly MAX_SESSION_LOG_BYTES (2MB) in one flush
    // by sending exactly 2MB (without the early flush at 4096 triggering first)
    // We do this by sending a 2MB chunk. Since buf starts empty, the chunk fills
    // buf, but buf.length > 4096 triggers flush() while the proc is running.
    // After flush, fullLog = 2MB. A second flush with any data: remaining = 0.
    const exactlyMax = 2 * 1024 * 1024 // 2 MB
    const fillChunk = 'b'.repeat(exactlyMax)

    // This single large chunk fills buf and triggers flush (buf.length > 4096)
    proc.stdout.emit('data', Buffer.from(fillChunk))

    // Allow the first flush (which fills fullLog to 2MB) to settle
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    // Now send more data — fullLog is at max, remaining = 0, so '' is appended
    proc.stdout.emit('data', Buffer.from('overflow data\n'))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    proc.emit('close', 0)
    await promise

    // The warn about truncation should have been emitted
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Build log exceeded 2 MB limit'),
    )
  })

  it('handles submitLogChunk failure gracefully (warning logged)', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const failingClient = {
      submitLogChunk: jest.fn().mockRejectedValue(new Error('network error')),
      saveSessionLog: jest.fn().mockResolvedValue(undefined),
    }

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile', failingClient as never, 'agent-1')

    await new Promise((r) => setImmediate(r))

    proc.stdout.emit('data', Buffer.from('output\n'))
    proc.emit('close', 0)

    await promise

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send log chunk'),
    )
  })

  it('handles saveSessionLog failure gracefully (warning logged)', async () => {
    const proc = makeFakeProc()
    mockSpawn.mockReturnValue(proc as never)

    const failingClient = {
      submitLogChunk: jest.fn().mockResolvedValue(undefined),
      saveSessionLog: jest.fn().mockRejectedValue(new Error('upload failed')),
    }

    const promise = buildProjectImage('mbc', 'PROJ_A', '1.0.0', '/path/Dockerfile', failingClient as never, 'agent-1')

    await new Promise((r) => setImmediate(r))

    proc.stdout.emit('data', Buffer.from('output\n'))
    proc.emit('close', 0)

    await promise

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to upload build log to S3'),
    )
  })
})
