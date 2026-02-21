import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { executeCommand } from '../src/command-executor'
import type { CommandResult } from '../src/types'

jest.mock('../src/logger')

function expectFailure(result: CommandResult): asserts result is { success: false; error: string; data?: unknown } {
  expect(result.success).toBe(false)
}

describe('command-executor', () => {
  describe('execute_command', () => {
    it('should execute a simple command', async () => {
      const result = await executeCommand('execute_command', { command: 'echo hello' })
      expect(result.success).toBe(true)
      expect((result.data as string).trim()).toBe('hello')
    })

    it('should return error for failing command', async () => {
      const result = await executeCommand('execute_command', {
        command: 'exit 1',
      })
      expect(result.success).toBe(false)
    })

    it('should return error when no command specified', async () => {
      const result = await executeCommand('execute_command', {})
      expectFailure(result)
      expect(result.error).toBe('No command specified')
    })

    it('should block dangerous rm -rf / command', async () => {
      const result = await executeCommand('execute_command', {
        command: 'rm -rf /',
      })
      expectFailure(result)
      expect(result.error).toContain('Blocked dangerous command pattern')
    })

    it('should block mkfs command', async () => {
      const result = await executeCommand('execute_command', {
        command: 'mkfs.ext4 /dev/sda1',
      })
      expectFailure(result)
      expect(result.error).toContain('Blocked dangerous command pattern')
    })

    it('should block dd to device command', async () => {
      const result = await executeCommand('execute_command', {
        command: 'dd if=/dev/zero of=/dev/sda',
      })
      expectFailure(result)
      expect(result.error).toContain('Blocked dangerous command pattern')
    })

    it('should block fork bomb command', async () => {
      const result = await executeCommand('execute_command', {
        command: ':(){ :|:& };:',
      })
      expectFailure(result)
      expect(result.error).toContain('Blocked dangerous command pattern')
    })

    it('should block fork bomb variant with spaces', async () => {
      const result = await executeCommand('execute_command', {
        command: ':() { :|:& };:',
      })
      expectFailure(result)
      expect(result.error).toContain('Blocked dangerous command pattern')
    })

    it('should allow safe rm commands', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-rm-${Date.now()}.txt`)
      fs.writeFileSync(tmpFile, 'temp')

      const result = await executeCommand('execute_command', {
        command: `rm ${tmpFile}`,
      })
      expect(result.success).toBe(true)
    })

    it('should timeout and kill long-running commands', async () => {
      const result = await executeCommand('execute_command', {
        command: 'sleep 60',
        timeout: 500,
      })
      expectFailure(result)
      expect(result.error).toContain('timed out')
    }, 10000)

    it('should return detailed error for non-existent command', async () => {
      const result = await executeCommand('execute_command', {
        command: '__nonexistent_command_xyz_12345__',
      })
      expectFailure(result)
      expect(result.error).toBeDefined()
    })
  })

  describe('file_read', () => {
    it('should read a file', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-read-${Date.now()}.txt`)
      fs.writeFileSync(tmpFile, 'test content')

      const result = await executeCommand('file_read', { path: tmpFile })
      expect(result.success).toBe(true)
      expect(result.data).toBe('test content')

      fs.unlinkSync(tmpFile)
    })

    it('should return error for missing path', async () => {
      const result = await executeCommand('file_read', {})
      expectFailure(result)
      expect(result.error).toBe('No file path specified')
    })

    it('should block reading /etc/shadow', async () => {
      const result = await executeCommand('file_read', { path: '/etc/shadow' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should block reading /proc/ paths', async () => {
      const result = await executeCommand('file_read', { path: '/proc/cpuinfo' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should reject files exceeding size limit', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-large-${Date.now()}.txt`)
      // Create a file and mock its stat to appear large
      fs.writeFileSync(tmpFile, 'small content')

      const originalStat = fs.promises.stat
      jest.spyOn(fs.promises, 'stat').mockImplementation(async (p, opts?) => {
        if (p === tmpFile) {
          const real = await originalStat(p, opts)
          return { ...real, size: 20 * 1024 * 1024 } as fs.Stats // 20 MB
        }
        return originalStat(p, opts)
      })

      const result = await executeCommand('file_read', { path: tmpFile })
      expectFailure(result)
      expect(result.error).toContain('File too large')

      jest.restoreAllMocks()
      fs.unlinkSync(tmpFile)
    })

    it('should allow reading files in tmpdir', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-allowed-${Date.now()}.txt`)
      fs.writeFileSync(tmpFile, 'allowed content')

      const result = await executeCommand('file_read', { path: tmpFile })
      expect(result.success).toBe(true)
      expect(result.data).toBe('allowed content')

      fs.unlinkSync(tmpFile)
    })
  })

  describe('file_write', () => {
    it('should write a file', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-write-${Date.now()}.txt`)

      const result = await executeCommand('file_write', {
        path: tmpFile,
        content: 'written content',
      })
      expect(result.success).toBe(true)
      expect(fs.readFileSync(tmpFile, 'utf-8')).toBe('written content')

      fs.unlinkSync(tmpFile)
    })

    it('should block writing to /etc/ paths', async () => {
      const result = await executeCommand('file_write', {
        path: '/etc/malicious',
        content: 'bad',
      })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should create parent directories when createDirectories is true', async () => {
      const tmpDir = path.join(os.tmpdir(), `test-mkdir-${Date.now()}`, 'sub', 'dir')
      const tmpFile = path.join(tmpDir, 'file.txt')

      const result = await executeCommand('file_write', {
        path: tmpFile,
        content: 'nested content',
        createDirectories: true,
      })
      expect(result.success).toBe(true)
      expect(fs.readFileSync(tmpFile, 'utf-8')).toBe('nested content')

      // Clean up the created tree
      const testDirName = tmpDir.split(path.sep).find(s => s.startsWith('test-mkdir-'))
      if (testDirName) {
        fs.rmSync(path.join(os.tmpdir(), testDirName), { recursive: true, force: true })
      }
    })

    it('should fail when parent directory does not exist and createDirectories is false', async () => {
      const tmpFile = path.join(os.tmpdir(), `nonexistent-${Date.now()}`, 'file.txt')

      const result = await executeCommand('file_write', {
        path: tmpFile,
        content: 'will fail',
      })
      expectFailure(result)
      expect(result.error).toBeDefined()
    })

    it('should reject content exceeding MAX_FILE_WRITE_SIZE', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-large-write-${Date.now()}.txt`)

      const result = await executeCommand('file_write', {
        path: tmpFile,
        content: 'x'.repeat(10 * 1024 * 1024 + 1),
      })
      expectFailure(result)
      expect(result.error).toContain('Content too large')
    })

    it('should accept content at exactly MAX_FILE_WRITE_SIZE', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-exact-limit-${Date.now()}.txt`)

      const result = await executeCommand('file_write', {
        path: tmpFile,
        content: 'x'.repeat(10 * 1024 * 1024),
      })
      expect(result.success).toBe(true)

      fs.unlinkSync(tmpFile)
    })

    it('should return error when no content specified', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-nocontent-${Date.now()}.txt`)

      const result = await executeCommand('file_write', {
        path: tmpFile,
      })
      expectFailure(result)
      expect(result.error).toBe('No content specified')
    })
  })

  describe('file_list', () => {
    it('should list directory contents', async () => {
      const result = await executeCommand('file_list', { path: os.tmpdir() })
      expect(result.success).toBe(true)
      const data = result.data as { items: unknown[]; truncated: boolean; total: number }
      expect(Array.isArray(data.items)).toBe(true)
      expect(typeof data.truncated).toBe('boolean')
      expect(typeof data.total).toBe('number')
    })

    it('should block listing /proc/', async () => {
      const result = await executeCommand('file_list', { path: '/proc/' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should return size:0 and modified:"" when stat fails for an entry', async () => {
      const tmpDir = path.join(os.tmpdir(), `test-list-stat-${Date.now()}`)
      fs.mkdirSync(tmpDir)
      fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'content')

      const originalLstat = fs.promises.lstat
      jest.spyOn(fs.promises, 'lstat').mockImplementation(async (p, opts?) => {
        if (p.toString().endsWith('file.txt')) {
          throw new Error('ENOENT: simulated lstat failure')
        }
        return originalLstat(p, opts)
      })

      const result = await executeCommand('file_list', { path: tmpDir })
      expect(result.success).toBe(true)
      const data = result.data as { items: Array<{ name: string; size: number; modified: string }> }
      const entry = data.items.find((i) => i.name === 'file.txt')
      expect(entry).toBeDefined()
      expect(entry!.size).toBe(0)
      expect(entry!.modified).toBe('')

      jest.restoreAllMocks()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })
  })

  describe('process_list', () => {
    it('should list processes', async () => {
      const result = await executeCommand('process_list', {})
      expect(result.success).toBe(true)
      expect(result.data).toBeDefined()
    })
  })

  describe('process_kill', () => {
    it('should return error when no PID specified', async () => {
      const result = await executeCommand('process_kill', {})
      expectFailure(result)
      expect(result.error).toContain('Invalid PID')
    })

    it('should reject negative PID', async () => {
      const result = await executeCommand('process_kill', { pid: -1 })
      expectFailure(result)
      expect(result.error).toContain('Invalid PID')
    })

    it('should reject PID of zero', async () => {
      const result = await executeCommand('process_kill', { pid: 0 })
      expectFailure(result)
      expect(result.error).toContain('Invalid PID')
    })

    it('should reject fractional PID', async () => {
      const result = await executeCommand('process_kill', { pid: 1.5 })
      expectFailure(result)
      expect(result.error).toContain('Invalid PID')
    })

    it('should reject negative process group PID', async () => {
      const result = await executeCommand('process_kill', { pid: -1234 })
      expectFailure(result)
      expect(result.error).toContain('Invalid PID')
    })

    it('should send signal to existing process', async () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true)

      const result = await executeCommand('process_kill', { pid: 12345 })
      expect(result.success).toBe(true)
      expect(result.data).toBe('Sent SIGTERM to PID 12345')
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM')

      killSpy.mockRestore()
    })

    it('should send SIGUSR1 signal when specified', async () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true)

      const result = await executeCommand('process_kill', { pid: 12345, signal: 'SIGUSR1' })
      expect(result.success).toBe(true)
      expect(result.data).toBe('Sent SIGUSR1 to PID 12345')
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGUSR1')

      killSpy.mockRestore()
    })

    it('should send SIGINT signal when specified', async () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true)

      const result = await executeCommand('process_kill', { pid: 12345, signal: 'SIGINT' })
      expect(result.success).toBe(true)
      expect(result.data).toBe('Sent SIGINT to PID 12345')
      expect(killSpy).toHaveBeenCalledWith(12345, 'SIGINT')

      killSpy.mockRestore()
    })

    it('should block SIGKILL signal', async () => {
      const result = await executeCommand('process_kill', { pid: 12345, signal: 'SIGKILL' })
      expectFailure(result)
      expect(result.error).toContain('Signal not allowed: SIGKILL')
    })

    it('should block SIGSTOP signal', async () => {
      const result = await executeCommand('process_kill', { pid: 12345, signal: 'SIGSTOP' })
      expectFailure(result)
      expect(result.error).toContain('Signal not allowed: SIGSTOP')
    })

    it('should return error when process does not exist', async () => {
      const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('kill ESRCH')
      })

      const result = await executeCommand('process_kill', { pid: 99999 })
      expectFailure(result)
      expect(result.error).toContain('kill ESRCH')

      killSpy.mockRestore()
    })
  })

  describe('unknown command type', () => {
    it('should return error for unknown command type', async () => {
      const result = await executeCommand('nonexistent_type' as any, {})
      expectFailure(result)
      expect(result.error).toBe('Unknown command type: nonexistent_type')
    })
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

      const resultPromise = executeCommand('execute_command', { command: 'echo test' })

      // Wait for spawn to be called (after async validateFilePath completes)
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

      const resultPromise = executeCommand('execute_command', { command: 'echo test' })

      await waitForSpawn(spawnSpy)

      const error = new Error('spawn EACCES') as NodeJS.ErrnoException
      error.code = 'EACCES'
      fakeProc.emit('error', error)

      const result = await resultPromise
      expectFailure(result)
      expect(result.error).toContain('Permission denied')

      spawnSpy.mockRestore()
    })

    it('should return raw error message for unknown error codes', async () => {
      const fakeProc = createFakeProc()
      const spawnSpy = jest.spyOn(child_process, 'spawn').mockReturnValueOnce(fakeProc as unknown as ChildProcess)

      const resultPromise = executeCommand('execute_command', { command: 'echo test' })

      await waitForSpawn(spawnSpy)

      const error = new Error('Something went wrong') as NodeJS.ErrnoException
      error.code = 'UNKNOWN'
      fakeProc.emit('error', error)

      const result = await resultPromise
      expectFailure(result)
      expect(result.error).toBe('Something went wrong')

      spawnSpy.mockRestore()
    })
  })

  describe('symlink path traversal', () => {
    const symlinkDir = path.join(os.tmpdir(), `test-symlink-${Date.now()}`)
    const symlinkPath = path.join(symlinkDir, 'link-to-etc')

    beforeAll(() => {
      fs.mkdirSync(symlinkDir, { recursive: true })
      try {
        fs.symlinkSync('/etc', symlinkPath)
      } catch {
        // May fail on some systems
      }
    })

    afterAll(() => {
      fs.rmSync(symlinkDir, { recursive: true, force: true })
    })

    it('should block file_read via symlink to /etc', async () => {
      if (!fs.existsSync(symlinkPath)) return // skip if symlink failed
      const result = await executeCommand('file_read', { path: `${symlinkPath}/passwd` })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should block file_write via symlink to /etc', async () => {
      if (!fs.existsSync(symlinkPath)) return
      const result = await executeCommand('file_write', { path: `${symlinkPath}/malicious`, content: 'bad' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should block file_list via symlink to /etc', async () => {
      if (!fs.existsSync(symlinkPath)) return
      const result = await executeCommand('file_list', { path: symlinkPath })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })
  })

  describe('environment variable leakage prevention', () => {
    it('should not pass sensitive env vars to child process', async () => {
      const originalToken = process.env.AI_SUPPORT_AGENT_TOKEN
      process.env.AI_SUPPORT_AGENT_TOKEN = 'secret-test-token'

      try {
        const result = await executeCommand('execute_command', { command: 'env' })
        expect(result.success).toBe(true)
        expect(result.data as string).not.toContain('AI_SUPPORT_AGENT_TOKEN')
        expect(result.data as string).not.toContain('secret-test-token')
      } finally {
        if (originalToken === undefined) delete process.env.AI_SUPPORT_AGENT_TOKEN
        else process.env.AI_SUPPORT_AGENT_TOKEN = originalToken
      }
    })

    it('should pass PATH to child process', async () => {
      const result = await executeCommand('execute_command', { command: 'env' })
      expect(result.success).toBe(true)
      expect(result.data as string).toContain('PATH=')
    })
  })

  describe('sensitive home directory paths', () => {
    it('should block reading ~/.ssh/id_rsa', async () => {
      const sshPath = path.join(os.homedir(), '.ssh', 'id_rsa')
      const result = await executeCommand('file_read', { path: sshPath })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should block reading ~/.aws/credentials', async () => {
      const awsPath = path.join(os.homedir(), '.aws', 'credentials')
      const result = await executeCommand('file_read', { path: awsPath })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should block reading ~/.gnupg/private-keys-v1.d', async () => {
      const gnupgPath = path.join(os.homedir(), '.gnupg', 'private-keys-v1.d')
      const result = await executeCommand('file_read', { path: gnupgPath })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should block writing to ~/.ssh/', async () => {
      const sshPath = path.join(os.homedir(), '.ssh', 'malicious_key')
      const result = await executeCommand('file_write', { path: sshPath, content: 'bad' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })
  })

  describe('file_list truncation', () => {
    it('should return truncated:false for normal directories', async () => {
      const tmpDir = path.join(os.tmpdir(), `test-list-normal-${Date.now()}`)
      fs.mkdirSync(tmpDir)
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a')
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b')

      const result = await executeCommand('file_list', { path: tmpDir })
      expect(result.success).toBe(true)
      const data = result.data as { items: unknown[]; truncated: boolean; total: number }
      expect(data.truncated).toBe(false)
      expect(data.total).toBe(2)
      expect(data.items).toHaveLength(2)

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('should truncate when entries exceed MAX_DIR_ENTRIES', async () => {
      // Mock readdir to return more than MAX_DIR_ENTRIES entries
      const fakeEntries = Array.from({ length: 1500 }, (_, i) => ({
        name: `file-${i}.txt`,
        isDirectory: () => false,
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const readdirSpy = jest.spyOn(fs.promises, 'readdir').mockResolvedValueOnce(fakeEntries as any)
      const statSpy = jest.spyOn(fs.promises, 'stat').mockResolvedValue({
        size: 100,
        mtime: new Date('2024-01-01'),
      } as fs.Stats)

      const result = await executeCommand('file_list', { path: os.tmpdir() })
      expect(result.success).toBe(true)
      const data = result.data as { items: unknown[]; truncated: boolean; total: number }
      expect(data.truncated).toBe(true)
      expect(data.total).toBe(1500)
      expect(data.items).toHaveLength(1000)

      readdirSpy.mockRestore()
      statSpy.mockRestore()
    })
  })

  describe('cwd validation', () => {
    it('should block cwd pointing to /etc', async () => {
      const result = await executeCommand('execute_command', { command: 'ls', cwd: '/etc' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })
  })

  describe('timeout limit', () => {
    it('should reject timeout exceeding MAX_CMD_TIMEOUT', async () => {
      const result = await executeCommand('execute_command', {
        command: 'echo test',
        timeout: 11 * 60 * 1000, // 11 minutes
      })
      expectFailure(result)
      expect(result.error).toContain('Timeout must be between 1 and')
    })

    it('should reject negative timeout', async () => {
      const result = await executeCommand('execute_command', {
        command: 'echo test',
        timeout: -100,
      })
      expectFailure(result)
      expect(result.error).toContain('Timeout must be between 1 and')
    })

    it('should reject zero timeout', async () => {
      const result = await executeCommand('execute_command', {
        command: 'echo test',
        timeout: 0,
      })
      expectFailure(result)
      expect(result.error).toContain('Timeout must be between 1 and')
    })

    it('should accept timeout of 1ms', async () => {
      const result = await executeCommand('execute_command', {
        command: 'echo test',
        timeout: 1,
      })
      // Should not fail with timeout validation error
      if (!result.success) {
        expect(result.error).not.toContain('Timeout must be between')
      }
    })
  })

  describe('outer try-catch', () => {
    it('should catch unexpected errors thrown by handler functions', async () => {
      const readdirSpy = jest.spyOn(fs.promises, 'readdir').mockRejectedValue(
        new Error('Unexpected internal error'),
      )

      const result = await executeCommand('file_list', { path: os.tmpdir() })
      expectFailure(result)
      expect(result.error).toBe('Unexpected internal error')

      readdirSpy.mockRestore()
    })
  })
})
