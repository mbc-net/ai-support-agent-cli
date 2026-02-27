import os from 'os'

import type { ApiClient } from '../../src/api-client'
import { buildClaudeArgs, buildCleanEnv, executeChatCommand } from '../../src/commands/chat-executor'
import { ERR_AGENT_ID_REQUIRED, ERR_MESSAGE_REQUIRED } from '../../src/constants'
import type { AgentServerConfig, ChatPayload } from '../../src/types'

jest.mock('../../src/logger')

// Mock api-chat-executor
jest.mock('../../src/commands/api-chat-executor', () => ({
  executeApiChatCommand: jest.fn().mockResolvedValue({
    success: true,
    data: 'api response',
  }),
}))

// Mock child_process for Claude Code CLI
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

describe('chat-executor', () => {
  const mockClient = {
    submitChatChunk: jest.fn().mockResolvedValue(undefined),
  } as unknown as ApiClient

  const basePayload: ChatPayload = {
    message: 'Hello, world!',
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('activeChatMode routing', () => {
    it('should use claude_code mode by default (no activeChatMode)', async () => {
      const { spawn } = require('child_process')
      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
      }
      spawn.mockReturnValue(mockProcess)

      mockProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') {
          cb(Buffer.from('CLI response'))
        }
      })
      mockProcess.stderr.on.mockImplementation(() => {})
      mockProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') {
          cb(0)
        }
      })

      const result = await executeChatCommand(basePayload, 'cmd-1', mockClient, undefined, undefined, 'agent-1')
      expect(result.success).toBe(true)
      expect(spawn).toHaveBeenCalledWith('claude', ['-p', 'Hello, world!'], expect.any(Object))
    })

    it('should use claude_code mode when activeChatMode is claude_code', async () => {
      const { spawn } = require('child_process')
      const mockProcess = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        on: jest.fn(),
      }
      spawn.mockReturnValue(mockProcess)
      mockProcess.stdout.on.mockImplementation((event: string, cb: (data: Buffer) => void) => {
        if (event === 'data') cb(Buffer.from('response'))
      })
      mockProcess.stderr.on.mockImplementation(() => {})
      mockProcess.on.mockImplementation((event: string, cb: (code: number | null) => void) => {
        if (event === 'close') cb(0)
      })

      const result = await executeChatCommand(basePayload, 'cmd-2', mockClient, undefined, 'claude_code', 'agent-1')
      expect(result.success).toBe(true)
      expect(spawn).toHaveBeenCalled()
    })

    it('should use api mode when activeChatMode is api', async () => {
      const { executeApiChatCommand } = require('../../src/commands/api-chat-executor')

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
      }

      const result = await executeChatCommand(basePayload, 'cmd-3', mockClient, serverConfig, 'api', 'agent-1')
      expect(result.success).toBe(true)
      expect(executeApiChatCommand).toHaveBeenCalledWith(
        basePayload, 'cmd-3', mockClient, serverConfig, 'agent-1',
      )
    })
  })

  describe('agentId validation', () => {
    it('should return error when agentId is missing', async () => {
      const result = await executeChatCommand(basePayload, 'cmd-no-agent', mockClient)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(ERR_AGENT_ID_REQUIRED)
      }
    })

    it('should return error when agentId is empty string', async () => {
      const result = await executeChatCommand(basePayload, 'cmd-empty-agent', mockClient, undefined, undefined, '')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(ERR_AGENT_ID_REQUIRED)
      }
    })
  })

  describe('message validation', () => {
    it('should return error when message is missing', async () => {
      const result = await executeChatCommand(
        { message: undefined } as ChatPayload,
        'cmd-5',
        mockClient,
        undefined,
        undefined,
        'agent-1',
      )
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe(ERR_MESSAGE_REQUIRED)
      }
    })
  })

  describe('Claude Code CLI error handling', () => {
    function createMockProcess() {
      const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
      const stdoutHandlers: Record<string, ((...args: unknown[]) => void)[]> = {}
      const stderrHandlers: Record<string, ((...args: unknown[]) => void)[]> = {}

      return {
        pid: 12345,
        killed: false,
        kill: jest.fn(),
        stdout: {
          on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
            stdoutHandlers[event] = stdoutHandlers[event] || []
            stdoutHandlers[event].push(cb)
          }),
        },
        stderr: {
          on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
            stderrHandlers[event] = stderrHandlers[event] || []
            stderrHandlers[event].push(cb)
          }),
        },
        on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
          handlers[event] = handlers[event] || []
          handlers[event].push(cb)
        }),
        emit(event: string, ...args: unknown[]) {
          for (const cb of handlers[event] || []) cb(...args)
        },
        emitStdout(event: string, ...args: unknown[]) {
          for (const cb of stdoutHandlers[event] || []) cb(...args)
        },
        emitStderr(event: string, ...args: unknown[]) {
          for (const cb of stderrHandlers[event] || []) cb(...args)
        },
      }
    }

    it('should return error when CLI exits with non-zero code', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand(basePayload, 'cmd-err-1', mockClient, undefined, undefined, 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emit('close', 1)

      const result = await resultPromise
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('コード 1')
      }
    })

    it('should include stderr in error when CLI exits with non-zero code', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand(basePayload, 'cmd-err-2', mockClient, undefined, undefined, 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStderr('data', Buffer.from('some error output'))
      mockProcess.emit('close', 2)

      const result = await resultPromise
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('some error output')
      }
    })

    it('should return ENOENT error when claude CLI is not found', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand(basePayload, 'cmd-enoent', mockClient, undefined, undefined, 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      const enoentError = new Error('spawn claude ENOENT') as NodeJS.ErrnoException
      enoentError.code = 'ENOENT'
      mockProcess.emit('error', enoentError)

      const result = await resultPromise
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('claude CLI')
      }
    })

    it('should return generic error for non-ENOENT spawn errors', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand(basePayload, 'cmd-generic-err', mockClient, undefined, undefined, 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emit('error', new Error('Permission denied'))

      const result = await resultPromise
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Permission denied')
      }
    })

    it('should send error chunk on failure', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand(basePayload, 'cmd-err-chunk', mockClient, undefined, undefined, 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emit('close', 1)

      await resultPromise

      expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-err-chunk', expect.objectContaining({
        type: 'error',
      }), 'agent-1')
    })

    it('should send done chunk on success', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand(basePayload, 'cmd-done', mockClient, undefined, undefined, 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('output text'))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // done chunk now includes JSON with text + metadata
      const doneCall = (mockClient.submitChatChunk as jest.Mock).mock.calls.find(
        (call: unknown[]) => (call[1] as { type: string }).type === 'done',
      )
      expect(doneCall).toBeTruthy()
      const doneContent = JSON.parse((doneCall[1] as { content: string }).content)
      expect(doneContent.text).toBe('output text')
      expect(doneContent.metadata).toEqual(expect.objectContaining({
        args: ['-p'],
        exitCode: 0,
        hasStderr: false,
      }))
      expect(typeof doneContent.metadata.durationMs).toBe('number')
    })

    it('should send delta chunks for stdout data', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand(basePayload, 'cmd-delta', mockClient, undefined, undefined, 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('chunk1'))
      mockProcess.emitStdout('data', Buffer.from('chunk2'))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-delta', expect.objectContaining({
        type: 'delta',
        content: 'chunk1',
      }), 'agent-1')
      expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-delta', expect.objectContaining({
        type: 'delta',
        content: 'chunk2',
      }), 'agent-1')
    })

    it('should pass allowedTools from serverConfig to CLI args', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          allowedTools: ['WebFetch', 'WebSearch'],
        },
      }

      const resultPromise = executeChatCommand(basePayload, 'cmd-tools', mockClient, serverConfig, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', '--allowedTools', 'WebFetch', '--allowedTools', 'WebSearch', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should not pass allowedTools when serverConfig has no claudeCodeConfig', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
      }

      const resultPromise = executeChatCommand(basePayload, 'cmd-no-tools', mockClient, serverConfig, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should not pass allowedTools when array is empty', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          allowedTools: [],
        },
      }

      const resultPromise = executeChatCommand(basePayload, 'cmd-empty-tools', mockClient, serverConfig, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should pass addDirs from serverConfig as --add-dir args', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          addDirs: ['~/projects/MBC_01'],
        },
      }

      const resultPromise = executeChatCommand(basePayload, 'cmd-dirs', mockClient, serverConfig, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      expect(args).toContain('--add-dir')
      // ~ should be resolved to homedir
      const addDirIdx = args.indexOf('--add-dir')
      expect(args[addDirIdx + 1]).not.toContain('~')
      expect(args[addDirIdx + 1]).toContain('projects/MBC_01')
    })

    it('should not pass --add-dir when addDirs is empty', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const serverConfig: AgentServerConfig = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        chatMode: 'agent',
        claudeCodeConfig: {
          addDirs: [],
        },
      }

      const resultPromise = executeChatCommand(basePayload, 'cmd-no-dirs', mockClient, serverConfig, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should pass --append-system-prompt for Japanese locale', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const payload: ChatPayload = { message: 'Hello', locale: 'ja' }

      const resultPromise = executeChatCommand(payload, 'cmd-locale-ja', mockClient, undefined, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      expect(args).toContain('--append-system-prompt')
      const promptIdx = args.indexOf('--append-system-prompt')
      expect(args[promptIdx + 1]).toContain('Japanese')
    })

    it('should pass --append-system-prompt for English locale', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const payload: ChatPayload = { message: 'Hello', locale: 'en' }

      const resultPromise = executeChatCommand(payload, 'cmd-locale-en', mockClient, undefined, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      expect(args).toContain('--append-system-prompt')
      const promptIdx = args.indexOf('--append-system-prompt')
      expect(args[promptIdx + 1]).toContain('English')
    })

    it('should not pass --append-system-prompt when locale is not provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand(basePayload, 'cmd-no-locale', mockClient, undefined, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(spawn).toHaveBeenCalledWith(
        'claude',
        ['-p', 'Hello, world!'],
        expect.any(Object),
      )
    })

    it('should inject AWS credentials into env when awsAccountId is provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const clientWithAws = {
        submitChatChunk: jest.fn().mockResolvedValue(undefined),
        getAwsCredentials: jest.fn().mockResolvedValue({
          accessKeyId: 'AKIATEST',
          secretAccessKey: 'secretTest',
          sessionToken: 'tokenTest',
          region: 'ap-northeast-1',
        }),
      } as unknown as ApiClient

      const payload: ChatPayload = { message: 'List S3 buckets', awsAccountId: 'prod' }

      const resultPromise = executeChatCommand(payload, 'cmd-aws', clientWithAws, undefined, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      expect((clientWithAws as any).getAwsCredentials).toHaveBeenCalledWith('prod')

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('AWS_ACCESS_KEY_ID', 'AKIATEST')
      expect(env).toHaveProperty('AWS_SECRET_ACCESS_KEY', 'secretTest')
      expect(env).toHaveProperty('AWS_SESSION_TOKEN', 'tokenTest')
      expect(env).toHaveProperty('AWS_DEFAULT_REGION', 'ap-northeast-1')
    })

    it('should not inject AWS credentials when awsAccountId is not provided', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const resultPromise = executeChatCommand(basePayload, 'cmd-no-aws', mockClient, undefined, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID')
      expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    })

    it('should continue without AWS credentials when getAwsCredentials fails', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const clientWithFailingAws = {
        submitChatChunk: jest.fn().mockResolvedValue(undefined),
        getAwsCredentials: jest.fn().mockRejectedValue(new Error('Not found')),
      } as unknown as ApiClient

      const payload: ChatPayload = { message: 'Hello', awsAccountId: 'invalid' }

      const resultPromise = executeChatCommand(payload, 'cmd-aws-fail', clientWithFailingAws, undefined, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID')
    })

    it('should filter CLAUDECODE env vars from child process', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const originalEnv = process.env
      process.env = { ...originalEnv, CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '1234', PATH: '/usr/bin' }

      const resultPromise = executeChatCommand(basePayload, 'cmd-env', mockClient, undefined, undefined, 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emit('close', 0)
      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).not.toHaveProperty('CLAUDECODE')
      expect(env).not.toHaveProperty('CLAUDE_CODE_SSE_PORT')
      expect(env).toHaveProperty('PATH')

      process.env = originalEnv
    })
  })

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
      // process.env can have undefined values when explicitly set
      process.env = { DEFINED: 'yes' }
      // Object.entries filters undefined naturally, but we test the contract
      const result = buildCleanEnv()
      expect(result).toHaveProperty('DEFINED', 'yes')
      // Verify no undefined values exist
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
})
