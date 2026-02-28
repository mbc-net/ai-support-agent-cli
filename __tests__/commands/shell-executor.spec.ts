import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { executeShellCommand } from '../../src/commands/shell-executor'
import { ERR_NO_COMMAND_SPECIFIED, MAX_OUTPUT_SIZE } from '../../src/constants'
import type { CommandResult } from '../../src/types'

function expectFailure(result: CommandResult): asserts result is { success: false; error: string; data?: unknown } {
  expect(result.success).toBe(false)
}

describe('shell-executor', () => {
  it('should execute a simple command', async () => {
    const result = await executeShellCommand({ command: 'echo hello' })
    expect(result.success).toBe(true)
    expect((result.data as string).trim()).toBe('hello')
  })

  it('should return error for failing command', async () => {
    const result = await executeShellCommand({ command: 'exit 1' })
    expect(result.success).toBe(false)
  })

  it('should return error when no command specified', async () => {
    const result = await executeShellCommand({})
    expectFailure(result)
    expect(result.error).toBe(ERR_NO_COMMAND_SPECIFIED)
  })

  it('should block dangerous rm -rf / command', async () => {
    const result = await executeShellCommand({ command: 'rm -rf /' })
    expectFailure(result)
    expect(result.error).toContain('Blocked dangerous command pattern')
  })

  it('should allow safe rm commands', async () => {
    const tmpFile = path.join(os.tmpdir(), `test-rm-shell-${Date.now()}.txt`)
    fs.writeFileSync(tmpFile, 'temp')

    const result = await executeShellCommand({ command: `rm ${tmpFile}` })
    expect(result.success).toBe(true)
  })

  it('should timeout and kill long-running commands', async () => {
    const result = await executeShellCommand({ command: 'sleep 60', timeout: 500 })
    expectFailure(result)
    expect(result.error).toContain('timed out')
  }, 10000)

  it('should block cwd pointing to /etc', async () => {
    const result = await executeShellCommand({ command: 'ls', cwd: '/etc' })
    expectFailure(result)
    expect(result.error).toContain('Access denied')
  })

  it('should reject timeout exceeding MAX_CMD_TIMEOUT', async () => {
    const result = await executeShellCommand({ command: 'echo test', timeout: 11 * 60 * 1000 })
    expectFailure(result)
    expect(result.error).toContain('Timeout must be between 1 and')
  })

  it('should reject negative timeout', async () => {
    const result = await executeShellCommand({ command: 'echo test', timeout: -100 })
    expectFailure(result)
    expect(result.error).toContain('Timeout must be between 1 and')
  })

  it('should not pass sensitive env vars to child process', async () => {
    const originalToken = process.env.AI_SUPPORT_AGENT_TOKEN
    process.env.AI_SUPPORT_AGENT_TOKEN = 'secret-test-token'

    try {
      const result = await executeShellCommand({ command: 'env' })
      expect(result.success).toBe(true)
      expect(result.data as string).not.toContain('AI_SUPPORT_AGENT_TOKEN')
    } finally {
      if (originalToken === undefined) delete process.env.AI_SUPPORT_AGENT_TOKEN
      else process.env.AI_SUPPORT_AGENT_TOKEN = originalToken
    }
  })

  describe('spawn error handling', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const child_process = require('child_process') as typeof import('child_process')
    const EventEmitter = require('events').EventEmitter as typeof import('events').EventEmitter

    type ChildProcess = import('child_process').ChildProcess

    interface FakeProcess extends InstanceType<typeof EventEmitter> {
      stdout: InstanceType<typeof EventEmitter>
      stderr: InstanceType<typeof EventEmitter>
      kill: jest.Mock
    }

    function createFakeProc(): FakeProcess {
      const proc = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: jest.fn(),
      })
      return proc as FakeProcess
    }

    function waitForSpawn(spy: jest.SpiedFunction<typeof child_process.spawn>): Promise<void> {
      return new Promise((resolve) => {
        const check = (): void => {
          if (spy.mock.calls.length > 0) {
            resolve()
          } else {
            setTimeout(check, 5)
          }
        }
        check()
      })
    }

    it('should return "Command not found" for ENOENT spawn error', async () => {
      const fakeProc = createFakeProc()
      const spawnSpy = jest.spyOn(child_process, 'spawn').mockReturnValueOnce(fakeProc as unknown as ChildProcess)

      const resultPromise = executeShellCommand({ command: 'echo test' })
      await waitForSpawn(spawnSpy)

      const error = new Error('spawn ENOENT') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      fakeProc.emit('error', error)

      const result = await resultPromise
      expectFailure(result)
      expect(result.error).toContain('Command not found')

      spawnSpy.mockRestore()
    })

    it('should return "Permission denied" for EACCES spawn error', async () => {
      const fakeProc = createFakeProc()
      const spawnSpy = jest.spyOn(child_process, 'spawn').mockReturnValueOnce(fakeProc as unknown as ChildProcess)

      const resultPromise = executeShellCommand({ command: 'echo test' })
      await waitForSpawn(spawnSpy)

      const error = new Error('spawn EACCES') as NodeJS.ErrnoException
      error.code = 'EACCES'
      fakeProc.emit('error', error)

      const result = await resultPromise
      expectFailure(result)
      expect(result.error).toContain('Permission denied')

      spawnSpy.mockRestore()
    })

    it('should not resolve twice when error fires after close', async () => {
      const fakeProc = createFakeProc()
      const spawnSpy = jest.spyOn(child_process, 'spawn').mockReturnValueOnce(fakeProc as unknown as ChildProcess)

      const resultPromise = executeShellCommand({ command: 'echo test' })
      await waitForSpawn(spawnSpy)

      // Close first (resolved=true), then error fires
      fakeProc.emit('close', 0)
      fakeProc.emit('error', new Error('Late error'))

      const result = await resultPromise
      expect(result.success).toBe(true)

      spawnSpy.mockRestore()
    })

    it('should truncate output exceeding MAX_OUTPUT_SIZE', async () => {
      const fakeProc = createFakeProc()
      const spawnSpy = jest.spyOn(child_process, 'spawn').mockReturnValueOnce(fakeProc as unknown as ChildProcess)

      const resultPromise = executeShellCommand({ command: 'echo test' })
      await waitForSpawn(spawnSpy)

      // Emit data exceeding MAX_OUTPUT_SIZE (10MB)
      const chunkSize = Math.ceil(MAX_OUTPUT_SIZE / 2) + 1
      const largeData = Buffer.alloc(chunkSize, 'A')
      fakeProc.stdout.emit('data', largeData)
      fakeProc.stdout.emit('data', largeData)
      fakeProc.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)
      expect(result.data as string).toContain('[output truncated]')

      spawnSpy.mockRestore()
    })

    it('should include stderr in error on non-zero exit', async () => {
      const fakeProc = createFakeProc()
      const spawnSpy = jest.spyOn(child_process, 'spawn').mockReturnValueOnce(fakeProc as unknown as ChildProcess)

      const resultPromise = executeShellCommand({ command: 'echo test' })
      await waitForSpawn(spawnSpy)

      fakeProc.stderr.emit('data', Buffer.from('error output'))
      fakeProc.emit('close', 1)

      const result = await resultPromise
      expectFailure(result)
      expect(result.error).toBe('error output')

      spawnSpy.mockRestore()
    })

    it('should show exit code when no stderr on non-zero exit', async () => {
      const fakeProc = createFakeProc()
      const spawnSpy = jest.spyOn(child_process, 'spawn').mockReturnValueOnce(fakeProc as unknown as ChildProcess)

      const resultPromise = executeShellCommand({ command: 'echo test' })
      await waitForSpawn(spawnSpy)

      fakeProc.emit('close', 42)

      const result = await resultPromise
      expectFailure(result)
      expect(result.error).toBe('Process exited with code 42')

      spawnSpy.mockRestore()
    })
  })
})
