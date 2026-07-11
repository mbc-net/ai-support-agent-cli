import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerTriggerE2eTestTool } from '../../../src/mcp/tools/trigger-e2e-test'

jest.mock('../../../src/api-client')

// randomUUID() produces v4 UUIDs
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('trigger-e2e-test tool', () => {
  let toolCallback: (args: { testCaseId: string; executionMethod?: 'ai' | 'script' | 'hybrid' | 'playwright'; environmentId?: string }) => Promise<unknown>
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('registerTriggerE2eTestTool', () => {
    it('should register the tool on the server with the expected name and schema', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerTriggerE2eTestTool(mockServer, mockClient)

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'trigger_e2e_test',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })

    it('should return a guard message when AI_SUPPORT_TASK_ID is not set', async () => {
      delete process.env.AI_SUPPORT_TASK_ID
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = { triggerE2eTest: jest.fn() } as unknown as ApiClient

      registerTriggerE2eTestTool(mockServer, mockClient)

      const result = await toolCallback({ testCaseId: 'case-456' }) as { content: Array<{ text: string }> }

      expect(result.content[0].text).toContain('only available during task execution')
      expect((mockClient.triggerE2eTest as jest.Mock)).not.toHaveBeenCalled()
    })

    it('should trigger the E2E test and return a JSON response on success', async () => {
      process.env.AI_SUPPORT_TASK_ID = 'task-abc-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerE2eTest: jest.fn().mockResolvedValue({
          success: true,
          data: { executionId: 'exec-1', dispatched: true },
        }),
      } as unknown as ApiClient

      registerTriggerE2eTestTool(mockServer, mockClient)

      const result = await toolCallback({ testCaseId: 'case-456', executionMethod: 'playwright', environmentId: 'env-1' })

      expect((mockClient.triggerE2eTest as jest.Mock)).toHaveBeenCalledWith(
        'case-456', 'task-abc-123', 'playwright', 'env-1', expect.stringMatching(UUID_V4_REGEX),
      )
      expect(result).toEqual({
        content: [{
          type: 'text',
          text: JSON.stringify({ executionId: 'exec-1', dispatched: true }, null, 2),
        }],
      })
    })

    it('should work without explicit executionMethod/environmentId', async () => {
      process.env.AI_SUPPORT_TASK_ID = 'task-abc-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerE2eTest: jest.fn().mockResolvedValue({ success: true, data: { dispatched: false } }),
      } as unknown as ApiClient

      registerTriggerE2eTestTool(mockServer, mockClient)

      await toolCallback({ testCaseId: 'case-456' })

      expect((mockClient.triggerE2eTest as jest.Mock)).toHaveBeenCalledWith(
        'case-456', 'task-abc-123', undefined, undefined, expect.stringMatching(UUID_V4_REGEX),
      )
    })

    it('should generate a fresh callId (UUID v4) per invocation', async () => {
      process.env.AI_SUPPORT_TASK_ID = 'task-abc-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerE2eTest: jest.fn().mockResolvedValue({ success: true, data: { dispatched: true } }),
      } as unknown as ApiClient

      registerTriggerE2eTestTool(mockServer, mockClient)

      await toolCallback({ testCaseId: 'case-456' })
      await toolCallback({ testCaseId: 'case-789' })

      const mockFn = mockClient.triggerE2eTest as jest.Mock
      const callId1 = mockFn.mock.calls[0][4]
      const callId2 = mockFn.mock.calls[1][4]

      expect(callId1).toMatch(UUID_V4_REGEX)
      expect(callId2).toMatch(UUID_V4_REGEX)
      expect(callId1).not.toBe(callId2)
    })

    it('should return an mcpErrorResponse when the API reports failure', async () => {
      process.env.AI_SUPPORT_TASK_ID = 'task-abc-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerE2eTest: jest.fn().mockResolvedValue({
          success: false,
          error: { code: 'INVALID_INPUT', message: 'testCaseId は必須です' },
        }),
      } as unknown as ApiClient

      registerTriggerE2eTestTool(mockServer, mockClient)

      const result = await toolCallback({ testCaseId: 'case-456' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: testCaseId は必須です' }],
        isError: true,
      })
    })

    it('should fall back to a default error message when the API omits error details', async () => {
      process.env.AI_SUPPORT_TASK_ID = 'task-abc-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerE2eTest: jest.fn().mockResolvedValue({ success: false }),
      } as unknown as ApiClient

      registerTriggerE2eTestTool(mockServer, mockClient)

      const result = await toolCallback({ testCaseId: 'case-456' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Failed to trigger E2E test' }],
        isError: true,
      })
    })

    it('should handle exceptions thrown by the API client', async () => {
      process.env.AI_SUPPORT_TASK_ID = 'task-abc-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerE2eTest: jest.fn().mockRejectedValue(new Error('network error')),
      } as unknown as ApiClient

      registerTriggerE2eTestTool(mockServer, mockClient)

      const result = await toolCallback({ testCaseId: 'case-456' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: network error' }],
        isError: true,
      })
    })
  })
})
