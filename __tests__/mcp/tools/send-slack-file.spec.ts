import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerSendSlackFileTool } from '../../../src/mcp/tools/send-slack-file'

jest.mock('../../../src/api-client')

// randomUUID() produces v4 UUIDs
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('send-slack-file tool', () => {
  let toolCallback: (args: { channel: string; fileName: string; content: string; threadTs?: string }) => Promise<unknown>

  describe('registerSendSlackFileTool', () => {
    it('should register the tool on the server with the expected name and schema', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerSendSlackFileTool(mockServer, mockClient)

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'send_slack_file',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })

    it('should send the Slack file and return a JSON response on success', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        sendSlackFile: jest.fn().mockResolvedValue({
          success: true,
          data: { fileId: 'F123456', permalink: 'https://slack.example.com/files/F123456' },
        }),
      } as unknown as ApiClient

      registerSendSlackFileTool(mockServer, mockClient)

      const result = await toolCallback({ channel: '#general', fileName: 'cost.csv', content: 'a,b\n1,2' })

      expect((mockClient.sendSlackFile as jest.Mock)).toHaveBeenCalledWith(
        '#general', 'cost.csv', 'a,b\n1,2', undefined, expect.stringMatching(UUID_V4_REGEX),
      )
      expect(result).toEqual({
        content: [{
          type: 'text',
          text: JSON.stringify({ fileId: 'F123456', permalink: 'https://slack.example.com/files/F123456' }, null, 2),
        }],
      })
    })

    it('should pass threadTs through to the API client', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        sendSlackFile: jest.fn().mockResolvedValue({ success: true, data: { fileId: 'F1' } }),
      } as unknown as ApiClient

      registerSendSlackFileTool(mockServer, mockClient)

      await toolCallback({ channel: '#general', fileName: 'cost.csv', content: 'data', threadTs: '111.222' })

      expect((mockClient.sendSlackFile as jest.Mock)).toHaveBeenCalledWith(
        '#general', 'cost.csv', 'data', '111.222', expect.stringMatching(UUID_V4_REGEX),
      )
    })

    it('should generate a fresh callId (UUID v4) per invocation', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        sendSlackFile: jest.fn().mockResolvedValue({ success: true, data: { fileId: 'F1' } }),
      } as unknown as ApiClient

      registerSendSlackFileTool(mockServer, mockClient)

      await toolCallback({ channel: '#general', fileName: 'cost.csv', content: 'a' })
      await toolCallback({ channel: '#general', fileName: 'cost.csv', content: 'b' })

      const mockFn = mockClient.sendSlackFile as jest.Mock
      const callId1 = mockFn.mock.calls[0][4]
      const callId2 = mockFn.mock.calls[1][4]

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
        sendSlackFile: jest.fn().mockResolvedValue({
          success: false,
          error: { code: 'SLACK_ERROR', message: 'channel_not_found' },
        }),
      } as unknown as ApiClient

      registerSendSlackFileTool(mockServer, mockClient)

      const result = await toolCallback({ channel: '#missing', fileName: 'cost.csv', content: 'data' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: channel_not_found' }],
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
        sendSlackFile: jest.fn().mockResolvedValue({ success: false }),
      } as unknown as ApiClient

      registerSendSlackFileTool(mockServer, mockClient)

      const result = await toolCallback({ channel: '#missing', fileName: 'cost.csv', content: 'data' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Failed to send Slack file' }],
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
        sendSlackFile: jest.fn().mockRejectedValue(new Error('network error')),
      } as unknown as ApiClient

      registerSendSlackFileTool(mockServer, mockClient)

      const result = await toolCallback({ channel: '#general', fileName: 'cost.csv', content: 'data' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: network error' }],
        isError: true,
      })
    })
  })
})
