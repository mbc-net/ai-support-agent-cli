import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerTriggerAlarmTool } from '../../../src/mcp/tools/trigger-alarm'

jest.mock('../../../src/api-client')

// randomUUID() produces v4 UUIDs
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('trigger-alarm tool', () => {
  let toolCallback: (args: { title: string; reason: string; priority?: 'urgent' | 'high' | 'medium' | 'low' }) => Promise<unknown>

  describe('registerTriggerAlarmTool', () => {
    it('should register the tool on the server with the expected name and schema', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerTriggerAlarmTool(mockServer, mockClient)

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'trigger_alarm',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })

    it('should trigger the alarm and return a JSON response on success', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerAlarm: jest.fn().mockResolvedValue({
          success: true,
          data: { alertNumber: 'AL000123', status: 'created' },
        }),
      } as unknown as ApiClient

      registerTriggerAlarmTool(mockServer, mockClient)

      const result = await toolCallback({ title: 'DB down', reason: 'Connection refused', priority: 'urgent' })

      expect((mockClient.triggerAlarm as jest.Mock)).toHaveBeenCalledWith(
        'DB down', 'Connection refused', 'urgent', expect.stringMatching(UUID_V4_REGEX),
      )
      expect(result).toEqual({
        content: [{
          type: 'text',
          text: JSON.stringify({ alertNumber: 'AL000123', status: 'created' }, null, 2),
        }],
      })
    })

    it('should work without an explicit priority', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerAlarm: jest.fn().mockResolvedValue({ success: true, data: { status: 'created' } }),
      } as unknown as ApiClient

      registerTriggerAlarmTool(mockServer, mockClient)

      await toolCallback({ title: 'DB down', reason: 'Connection refused' })

      expect((mockClient.triggerAlarm as jest.Mock)).toHaveBeenCalledWith(
        'DB down', 'Connection refused', undefined, expect.stringMatching(UUID_V4_REGEX),
      )
    })

    it('should generate a fresh callId (UUID v4) per invocation', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerAlarm: jest.fn().mockResolvedValue({ success: true, data: { status: 'created' } }),
      } as unknown as ApiClient

      registerTriggerAlarmTool(mockServer, mockClient)

      await toolCallback({ title: 'DB down', reason: 'Connection refused' })
      await toolCallback({ title: 'API down', reason: 'Timeout' })

      const mockFn = mockClient.triggerAlarm as jest.Mock
      const callId1 = mockFn.mock.calls[0][3]
      const callId2 = mockFn.mock.calls[1][3]

      expect(callId1).toMatch(UUID_V4_REGEX)
      expect(callId2).toMatch(UUID_V4_REGEX)
      expect(callId1).not.toBe(callId2)
    })

    it('should return an mcpErrorResponse when the API reports failure', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerAlarm: jest.fn().mockResolvedValue({
          success: false,
          error: { code: 'ALARM_ERROR', message: 'rate limited' },
        }),
      } as unknown as ApiClient

      registerTriggerAlarmTool(mockServer, mockClient)

      const result = await toolCallback({ title: 'DB down', reason: 'Connection refused' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: rate limited' }],
        isError: true,
      })
    })

    it('should fall back to a default error message when the API omits error details', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerAlarm: jest.fn().mockResolvedValue({ success: false }),
      } as unknown as ApiClient

      registerTriggerAlarmTool(mockServer, mockClient)

      const result = await toolCallback({ title: 'DB down', reason: 'Connection refused' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Failed to trigger alarm' }],
        isError: true,
      })
    })

    it('should handle exceptions thrown by the API client', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        triggerAlarm: jest.fn().mockRejectedValue(new Error('network error')),
      } as unknown as ApiClient

      registerTriggerAlarmTool(mockServer, mockClient)

      const result = await toolCallback({ title: 'DB down', reason: 'Connection refused' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: network error' }],
        isError: true,
      })
    })
  })
})
