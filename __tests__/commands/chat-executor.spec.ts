import type { ApiClient } from '../../src/api-client'
import { executeChatCommand } from '../../src/commands/chat-executor'
import { ERR_AGENT_ID_REQUIRED, ERR_MESSAGE_REQUIRED } from '../../src/constants'
import type { AgentServerConfig, ChatPayload, ProjectConfigResponse } from '../../src/types'

jest.mock('../../src/logger')

// Mock project-dir
jest.mock('../../src/project-dir', () => ({
  getAutoAddDirs: jest.fn().mockReturnValue(['/mock/repos', '/mock/docs']),
}))

// Mock aws-credential-builder
jest.mock('../../src/aws-credential-builder', () => ({
  buildAwsProfileCredentials: jest.fn().mockResolvedValue({
    env: {
      AWS_CONFIG_FILE: '/mock/.ai-support-agent/aws/config',
      AWS_SHARED_CREDENTIALS_FILE: '/mock/.ai-support-agent/aws/credentials',
      AWS_PROFILE: 'TEST-dev',
      AWS_DEFAULT_REGION: 'ap-northeast-1',
    },
    errors: [],
  }),
  buildSingleAccountAwsEnv: jest.fn().mockResolvedValue({ errors: [] }),
}))

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

      const { buildSingleAccountAwsEnv } = require('../../src/aws-credential-builder')
      ;(buildSingleAccountAwsEnv as jest.Mock).mockResolvedValueOnce({
        env: {
          AWS_ACCESS_KEY_ID: 'AKIATEST',
          AWS_SECRET_ACCESS_KEY: 'secretTest',
          AWS_SESSION_TOKEN: 'tokenTest',
          AWS_DEFAULT_REGION: 'ap-northeast-1',
        },
        errors: [],
      })

      const payload: ChatPayload = { message: 'List S3 buckets', awsAccountId: 'prod' }

      const resultPromise = executeChatCommand(payload, 'cmd-aws', mockClient, undefined, 'claude_code', 'agent-1')

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(buildSingleAccountAwsEnv).toHaveBeenCalledWith(mockClient, 'prod')

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

    it('should continue without AWS credentials when buildSingleAccountAwsEnv returns undefined', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildSingleAccountAwsEnv } = require('../../src/aws-credential-builder')
      ;(buildSingleAccountAwsEnv as jest.Mock).mockResolvedValueOnce({ errors: [] })

      const payload: ChatPayload = { message: 'Hello', awsAccountId: 'invalid' }

      const resultPromise = executeChatCommand(payload, 'cmd-aws-fail', mockClient, undefined, 'claude_code', 'agent-1')

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

  describe('AWS profile mode', () => {
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
      }
    }

    const projectConfig: ProjectConfigResponse = {
      configHash: 'test-hash',
      project: { projectCode: 'TEST', projectName: 'Test Project' },
      agent: {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        allowedTools: [],
      },
      aws: {
        accounts: [
          {
            id: '1',
            name: 'dev',
            description: 'Dev account',
            region: 'ap-northeast-1',
            accountId: '123456789012',
            auth: { method: 'access_key' },
            isDefault: true,
          },
        ],
      },
    }

    it('should use profile mode when projectDir and projectConfig.aws.accounts are present', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildAwsProfileCredentials } = require('../../src/aws-credential-builder')
      ;(buildAwsProfileCredentials as jest.Mock).mockResolvedValueOnce({
        env: {
          AWS_CONFIG_FILE: '/mock/.ai-support-agent/aws/config',
          AWS_SHARED_CREDENTIALS_FILE: '/mock/.ai-support-agent/aws/credentials',
          AWS_PROFILE: 'TEST-dev',
          AWS_DEFAULT_REGION: 'ap-northeast-1',
        },
        errors: [],
      })

      const resultPromise = executeChatCommand(
        basePayload, 'cmd-profile', mockClient, undefined, 'claude_code', 'agent-1',
        '/tmp/project', projectConfig,
      )

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // Should have called buildAwsProfileCredentials
      expect(buildAwsProfileCredentials).toHaveBeenCalledWith(mockClient, '/tmp/project', projectConfig)

      // Should have used profile env
      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('AWS_CONFIG_FILE')
      expect(env).toHaveProperty('AWS_SHARED_CREDENTIALS_FILE')
      expect(env).toHaveProperty('AWS_PROFILE', 'TEST-dev')
    })

    it('should fall back to legacy mode when no projectConfig', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildSingleAccountAwsEnv } = require('../../src/aws-credential-builder')
      ;(buildSingleAccountAwsEnv as jest.Mock).mockResolvedValueOnce({
        env: {
          AWS_ACCESS_KEY_ID: 'AKIALEGACY',
          AWS_SECRET_ACCESS_KEY: 'secretLegacy',
          AWS_SESSION_TOKEN: 'tokenLegacy',
          AWS_DEFAULT_REGION: 'us-east-1',
        },
        errors: [],
      })

      const payload: ChatPayload = { message: 'Hello', awsAccountId: 'legacy-account' }

      const resultPromise = executeChatCommand(
        payload, 'cmd-legacy', mockClient, undefined, 'claude_code', 'agent-1',
        '/tmp/project', undefined, // no projectConfig
      )

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      expect(buildSingleAccountAwsEnv).toHaveBeenCalledWith(mockClient, 'legacy-account')

      // Should use legacy env vars
      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).toHaveProperty('AWS_ACCESS_KEY_ID', 'AKIALEGACY')
      expect(env).toHaveProperty('AWS_SECRET_ACCESS_KEY', 'secretLegacy')
    })

    it('should continue without AWS env when all credential fetches fail in profile mode', async () => {
      const { spawn } = require('child_process')
      const mockProcess = createMockProcess()
      spawn.mockReturnValue(mockProcess)

      const { buildAwsProfileCredentials } = require('../../src/aws-credential-builder')
      ;(buildAwsProfileCredentials as jest.Mock).mockResolvedValueOnce({ errors: ['Credential fetch failed'] })

      const resultPromise = executeChatCommand(
        basePayload, 'cmd-profile-fail', mockClient, undefined, 'claude_code', 'agent-1',
        '/tmp/project', projectConfig,
      )

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      const result = await resultPromise
      expect(result.success).toBe(true)

      // Should NOT have profile env vars (all credentials failed)
      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const env = spawnCall[2].env
      expect(env).not.toHaveProperty('AWS_PROFILE')
    })
  })

  describe('project directory auto-add dirs', () => {
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
      }
    }

    it('should merge auto-add dirs with server addDirs when projectDir is set', async () => {
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
          addDirs: ['/server/dir'],
        },
      }

      const resultPromise = executeChatCommand(
        basePayload, 'cmd-auto-add', mockClient, serverConfig, 'claude_code', 'agent-1',
        '/tmp/project',
      )

      await new Promise((r) => setTimeout(r, 10))
      mockProcess.emitStdout('data', Buffer.from('response'))
      mockProcess.emit('close', 0)

      await resultPromise

      const spawnCall = spawn.mock.calls[spawn.mock.calls.length - 1]
      const args = spawnCall[1] as string[]
      // Should include both auto-add dirs and server dirs
      expect(args).toContain('--add-dir')
      // auto-add dirs: /mock/repos, /mock/docs, server dir: /server/dir
      const addDirIndices = args.reduce<number[]>((acc, arg, i) => {
        if (arg === '--add-dir') acc.push(i)
        return acc
      }, [])
      expect(addDirIndices.length).toBe(3) // repos, docs, server/dir
    })
  })
})
