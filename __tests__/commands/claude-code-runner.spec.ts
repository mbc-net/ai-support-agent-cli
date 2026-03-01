import os from 'os'

import { ERR_CLAUDE_CLI_NOT_FOUND } from '../../src/constants'
import { buildClaudeArgs, buildCleanEnv, runClaudeCode } from '../../src/commands/claude-code-runner'
import { createMockChildProcess } from '../helpers/mock-factory'

jest.mock('../../src/logger')

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

describe('claude-code-runner', () => {
  describe('buildCleanEnv', () => {
    let originalEnv: NodeJS.ProcessEnv

    beforeEach(() => {
      originalEnv = process.env
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should exclude CLAUDECODE', () => {
      process.env = { CLAUDECODE: '1', HOME: '/home/user' }
      const result = buildCleanEnv()
      expect(result).not.toHaveProperty('CLAUDECODE')
      expect(result).toHaveProperty('HOME', '/home/user')
    })

    it('should exclude CLAUDE_CODE_* variables', () => {
      process.env = { CLAUDE_CODE_SSE_PORT: '1234', CLAUDE_CODE_FOO: 'bar', PATH: '/usr/bin' }
      const result = buildCleanEnv()
      expect(result).not.toHaveProperty('CLAUDE_CODE_SSE_PORT')
      expect(result).not.toHaveProperty('CLAUDE_CODE_FOO')
      expect(result).toHaveProperty('PATH', '/usr/bin')
    })

    it('should keep other environment variables', () => {
      process.env = { NODE_ENV: 'test', HOME: '/home/user', LANG: 'en_US.UTF-8' }
      const result = buildCleanEnv()
      expect(result).toEqual({ NODE_ENV: 'test', HOME: '/home/user', LANG: 'en_US.UTF-8' })
    })

    it('should exclude undefined values', () => {
      process.env = { DEFINED: 'yes' }
      const result = buildCleanEnv()
      expect(result).toHaveProperty('DEFINED', 'yes')
      for (const value of Object.values(result)) {
        expect(value).toBeDefined()
      }
    })
  })

  describe('buildClaudeArgs', () => {
    it('should return ["-p", message] for basic message', () => {
      const result = buildClaudeArgs('hello')
      expect(result).toEqual(['-p', 'hello'])
    })

    it('should add --allowedTools for each tool', () => {
      const result = buildClaudeArgs('hello', { allowedTools: ['WebFetch', 'WebSearch'] })
      expect(result).toEqual(['-p', '--allowedTools', 'WebFetch', '--allowedTools', 'WebSearch', 'hello'])
    })

    it('should add --add-dir for each directory', () => {
      const result = buildClaudeArgs('hello', { addDirs: ['/tmp/project'] })
      expect(result).toEqual(['-p', '--add-dir', '/tmp/project', 'hello'])
    })

    it('should resolve ~ to homedir in addDirs', () => {
      const result = buildClaudeArgs('hello', { addDirs: ['~/projects/MBC_01'] })
      expect(result).toContain('--add-dir')
      const addDirIdx = result.indexOf('--add-dir')
      expect(result[addDirIdx + 1]).toBe(`${os.homedir()}/projects/MBC_01`)
      expect(result[addDirIdx + 1]).not.toContain('~')
    })

    it('should add --append-system-prompt with Japanese prompt for locale "ja"', () => {
      const result = buildClaudeArgs('hello', { locale: 'ja' })
      expect(result).toContain('--append-system-prompt')
      const promptIdx = result.indexOf('--append-system-prompt')
      expect(result[promptIdx + 1]).toContain('Japanese')
    })

    it('should add --append-system-prompt with English prompt for locale "en"', () => {
      const result = buildClaudeArgs('hello', { locale: 'en' })
      expect(result).toContain('--append-system-prompt')
      const promptIdx = result.indexOf('--append-system-prompt')
      expect(result[promptIdx + 1]).toContain('English')
    })

    it('should not add --append-system-prompt when locale is not provided', () => {
      const result = buildClaudeArgs('hello')
      expect(result).not.toContain('--append-system-prompt')
    })

    it('should not add --allowedTools when array is empty', () => {
      const result = buildClaudeArgs('hello', { allowedTools: [] })
      expect(result).toEqual(['-p', 'hello'])
    })

    it('should not add --add-dir when array is empty', () => {
      const result = buildClaudeArgs('hello', { addDirs: [] })
      expect(result).toEqual(['-p', 'hello'])
    })

    it('should handle all options combined', () => {
      const result = buildClaudeArgs('hello', {
        allowedTools: ['WebFetch'],
        addDirs: ['/tmp/dir'],
        locale: 'ja',
      })
      expect(result).toContain('--allowedTools')
      expect(result).toContain('WebFetch')
      expect(result).toContain('--add-dir')
      expect(result).toContain('/tmp/dir')
      expect(result).toContain('--append-system-prompt')
      expect(result[result.length - 1]).toBe('hello')
    })
  })

  describe('runClaudeCode', () => {
    beforeEach(() => {
      jest.clearAllMocks()
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('should resolve with text and metadata on success', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emitStdout('data', Buffer.from('response text'))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.text).toBe('response text')
      expect(result.metadata.exitCode).toBe(0)
      expect(result.metadata.hasStderr).toBe(false)
      expect(result.metadata.args).toEqual(['-p'])
      expect(typeof result.metadata.durationMs).toBe('number')
    })

    it('should send delta chunks for stdout data', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emitStdout('data', Buffer.from('chunk1'))
      mockProcess.emitStdout('data', Buffer.from('chunk2'))
      mockProcess.emit('close', 0)

      await resultPromise
      expect(sendChunk).toHaveBeenCalledWith('delta', 'chunk1')
      expect(sendChunk).toHaveBeenCalledWith('delta', 'chunk2')
    })

    it('should reject when CLI exits with non-zero code', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emit('close', 1)

      await expect(resultPromise).rejects.toThrow('コード 1')
    })

    it('should include stderr in error message when CLI exits with non-zero code', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emitStderr('data', Buffer.from('error output'))
      mockProcess.emit('close', 2)

      await expect(resultPromise).rejects.toThrow('error output')
    })

    it('should reject with ENOENT error when claude CLI is not found', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      const enoentError = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      enoentError.code = 'ENOENT'
      mockProcess.emit('error', enoentError)

      await expect(resultPromise).rejects.toThrow(ERR_CLAUDE_CLI_NOT_FOUND)
    })

    it('should reject with original error for non-ENOENT errors', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emit('error', new Error('Permission denied'))

      await expect(resultPromise).rejects.toThrow('Permission denied')
    })

    it('should pass awsEnv to spawn environment', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)
      const awsEnv = { AWS_ACCESS_KEY_ID: 'AKIA', AWS_SECRET_ACCESS_KEY: 'secret' }

      const resultPromise = runClaudeCode('hello', sendChunk, undefined, undefined, undefined, awsEnv)

      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[0]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('AWS_ACCESS_KEY_ID', 'AKIA')
      expect(env).toHaveProperty('AWS_SECRET_ACCESS_KEY', 'secret')
    })

    it('should detect stderr output in metadata', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      mockProcess.emitStdout('data', Buffer.from('output'))
      mockProcess.emitStderr('data', Buffer.from('warning'))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.metadata.hasStderr).toBe(true)
    })

    it('should send SIGTERM on timeout and SIGKILL if still running', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockChildProcess()
      spawn.mockReturnValue(mockProcess)

      const sendChunk = jest.fn().mockResolvedValue(undefined)

      const resultPromise = runClaudeCode('hello', sendChunk)

      // Advance past CHAT_TIMEOUT to trigger SIGTERM
      jest.advanceTimersByTime(120_000)
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM')

      // Advance past SIGKILL delay — process not killed yet
      mockProcess.killed = false
      jest.advanceTimersByTime(5_000)
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGKILL')

      // Complete the process to resolve the promise
      mockProcess.emit('close', 1)
      await expect(resultPromise).rejects.toThrow()
    })
  })
})
