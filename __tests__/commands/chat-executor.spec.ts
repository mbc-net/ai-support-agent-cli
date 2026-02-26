import type { ApiClient } from '../../src/api-client'
import { executeChatCommand } from '../../src/commands/chat-executor'
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
        expect(result.error).toBe('agentId is required for chat command')
      }
    })

    it('should return error when agentId is empty string', async () => {
      const result = await executeChatCommand(basePayload, 'cmd-empty-agent', mockClient, undefined, undefined, '')
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toBe('agentId is required for chat command')
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
        expect(result.error).toBe('message is required')
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

      expect(mockClient.submitChatChunk).toHaveBeenCalledWith('cmd-done', expect.objectContaining({
        type: 'done',
        content: 'output text',
      }), 'agent-1')
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
})
