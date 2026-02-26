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
})
