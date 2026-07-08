/**
 * Tests for src/commands/index.ts — chat and e2e_test happy paths.
 *
 * These tests cover the branches that reach executeChatCommand and
 * executeE2eTest (lines 110 and 170-173 in src/commands/index.ts).
 * They are isolated from dispatch.spec.ts to allow mocking chat-executor
 * and e2e-test-executor without affecting other tests.
 */

import type { ApiClient } from '../../src/api-client'
import type { CommandResult } from '../../src/types'

jest.mock('../../src/logger')

jest.mock('../../src/commands/chat-executor', () => ({
  executeChatCommand: jest.fn().mockResolvedValue({ success: true, data: 'chat result' }),
  buildClaudeArgs: jest.fn().mockReturnValue([]),
  buildCleanEnv: jest.fn().mockReturnValue({}),
  _resetCleanEnvCache: jest.fn(),
}))

jest.mock('../../src/commands/e2e-test-executor', () => ({
  executeE2eTest: jest.fn().mockResolvedValue({ success: true, data: 'e2e result' }),
}))

import { executeCommand } from '../../src/commands'
import { executeChatCommand } from '../../src/commands/chat-executor'
import { executeE2eTest } from '../../src/commands/e2e-test-executor'

const mockExecuteChatCommand = executeChatCommand as jest.MockedFunction<typeof executeChatCommand>
const mockExecuteE2eTest = executeE2eTest as jest.MockedFunction<typeof executeE2eTest>

describe('commands/dispatch — chat and e2e_test happy paths', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExecuteChatCommand.mockResolvedValue({ success: true, data: 'chat result' })
    mockExecuteE2eTest.mockResolvedValue({ success: true, data: 'e2e result' })
  })

  describe('chat command happy path', () => {
    it('should call executeChatCommand when commandId and client are provided', async () => {
      const mockClient = {} as ApiClient

      const result = await executeCommand(
        'chat' as Parameters<typeof executeCommand>[0],
        { message: 'hello' },
        {
          commandId: 'cmd-1',
          client: mockClient,
          agentId: 'agent-1',
        },
      )

      expect(mockExecuteChatCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: 'cmd-1',
          client: mockClient,
          agentId: 'agent-1',
        }),
      )
      expect((result as CommandResult).success).toBe(true)
    })

    it('should pass all optional chat options to executeChatCommand', async () => {
      const mockClient = {} as ApiClient
      const serverConfig = { apiUrl: 'http://api.example.com' } as never
      const projectConfig = { configHash: 'abc123' } as never

      await executeCommand(
        'chat' as Parameters<typeof executeCommand>[0],
        { message: 'test' },
        {
          commandId: 'cmd-2',
          client: mockClient,
          serverConfig,
          activeChatMode: undefined,
          agentId: 'agent-2',
          projectDir: '/some/dir',
          projectConfig,
          mcpConfigPath: '/path/to/mcp.json',
          tenantCode: 'mbc',
          browserLocalPort: 9222,
        },
      )

      expect(mockExecuteChatCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: 'cmd-2',
          client: mockClient,
          serverConfig,
          agentId: 'agent-2',
          projectDir: '/some/dir',
          projectConfig,
          mcpConfigPath: '/path/to/mcp.json',
          tenantCode: 'mbc',
          browserLocalPort: 9222,
        }),
      )
    })

    it('should propagate CommandDispatch form for chat with client', async () => {
      const mockClient = {} as ApiClient

      const result = await executeCommand(
        { type: 'chat', payload: { message: 'dispatch test' } } as never,
        {
          commandId: 'cmd-dispatch',
          client: mockClient,
        },
      )

      expect(mockExecuteChatCommand).toHaveBeenCalled()
      expect((result as CommandResult).success).toBe(true)
    })

    it('should prefer per-message agentChatMode over activeChatMode for chat', async () => {
      const mockClient = {} as ApiClient

      const result = await executeCommand(
        'chat' as Parameters<typeof executeCommand>[0],
        { message: 'use codex', agentChatMode: 'codex' },
        {
          commandId: 'cmd-runtime',
          client: mockClient,
          activeChatMode: 'claude_code',
          availableChatModes: ['claude_code', 'codex'],
        } as never,
      )

      expect(mockExecuteChatCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          activeChatMode: 'codex',
        }),
      )
      expect((result as CommandResult).success).toBe(true)
    })

    it('should fail when an explicit per-message agentChatMode is unavailable', async () => {
      const mockClient = {} as ApiClient

      const result = await executeCommand(
        'chat' as Parameters<typeof executeCommand>[0],
        { message: 'use codex', agentChatMode: 'codex' },
        {
          commandId: 'cmd-runtime-unavailable',
          client: mockClient,
          activeChatMode: 'claude_code',
          availableChatModes: ['claude_code'],
        } as never,
      ) as CommandResult

      expect(result.success).toBe(false)
      expect(result.error).toContain('codex')
      expect(mockExecuteChatCommand).not.toHaveBeenCalled()
    })
  })

  describe('e2e_test command happy path', () => {
    it('should call executeE2eTest when commandId and client are provided', async () => {
      const mockClient = {} as ApiClient

      const result = await executeCommand(
        'e2e_test' as Parameters<typeof executeCommand>[0],
        { script: 'test script' },
        {
          commandId: 'e2e-cmd-1',
          client: mockClient,
          agentId: 'agent-e2e',
        },
      )

      expect(mockExecuteE2eTest).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: 'e2e-cmd-1',
          client: mockClient,
          agentId: 'agent-e2e',
        }),
      )
      expect((result as CommandResult).success).toBe(true)
    })

    it('should return error for e2e_test without commandId', async () => {
      const mockClient = {} as ApiClient

      const result = await executeCommand(
        'e2e_test' as Parameters<typeof executeCommand>[0],
        { script: 'test script' },
        { client: mockClient },
      ) as CommandResult

      expect(result.success).toBe(false)
      expect(mockExecuteE2eTest).not.toHaveBeenCalled()
    })

    it('should return error for e2e_test without client', async () => {
      const result = await executeCommand(
        'e2e_test' as Parameters<typeof executeCommand>[0],
        { script: 'test script' },
        { commandId: 'e2e-cmd-no-client' },
      ) as CommandResult

      expect(result.success).toBe(false)
      expect(mockExecuteE2eTest).not.toHaveBeenCalled()
    })

    it('should pass all optional e2e_test options to executeE2eTest', async () => {
      const mockClient = {} as ApiClient
      const serverConfig = { apiUrl: 'http://api.example.com' } as never

      await executeCommand(
        'e2e_test' as Parameters<typeof executeCommand>[0],
        { script: 'test' },
        {
          commandId: 'e2e-cmd-2',
          client: mockClient,
          serverConfig,
          agentId: 'agent-3',
          projectDir: '/project/dir',
          mcpConfigPath: '/mcp.json',
          tenantCode: 'mbc',
          browserLocalPort: 8080,
        },
      )

      expect(mockExecuteE2eTest).toHaveBeenCalledWith(
        expect.objectContaining({
          commandId: 'e2e-cmd-2',
          client: mockClient,
          serverConfig,
          agentId: 'agent-3',
          projectDir: '/project/dir',
          mcpConfigPath: '/mcp.json',
          tenantCode: 'mbc',
          browserLocalPort: 8080,
        }),
      )
    })

    it('should propagate CommandDispatch form for e2e_test with client', async () => {
      const mockClient = {} as ApiClient

      const result = await executeCommand(
        { type: 'e2e_test', payload: { script: 'dispatch test' } } as never,
        {
          commandId: 'e2e-dispatch',
          client: mockClient,
        },
      )

      expect(mockExecuteE2eTest).toHaveBeenCalled()
      expect((result as CommandResult).success).toBe(true)
    })

    it('should use e2eTest runtime override from serverConfig', async () => {
      const mockClient = {} as ApiClient

      await executeCommand(
        'e2e_test' as Parameters<typeof executeCommand>[0],
        { script: 'test' },
        {
          commandId: 'e2e-runtime',
          client: mockClient,
          activeChatMode: 'claude_code',
          availableChatModes: ['claude_code', 'codex'],
          serverConfig: {
            agentChatModeOverrides: { e2eTest: 'codex' },
          },
        } as never,
      )

      expect(mockExecuteE2eTest).toHaveBeenCalledWith(
        expect.objectContaining({
          activeChatMode: 'codex',
        }),
      )
    })
  })
})
