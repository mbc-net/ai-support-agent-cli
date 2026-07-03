import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerSendSlackMessageTool } from '../../../src/mcp/tools/send-slack-message'

jest.mock('../../../src/api-client')

// randomUUID() produces v4 UUIDs
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('send-slack-message tool', () => {
  let toolCallback: (args: { channel: string; message: string; threadTs?: string }) => Promise<unknown>

  describe('registerSendSlackMessageTool', () => {
    it('should register the tool on the server with the expected name and schema', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerSendSlackMessageTool(mockServer, mockClient)

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'send_slack_message',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })

    it('should send the Slack message and return a JSON response on success', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        sendSlackMessage: jest.fn().mockResolvedValue({
          success: true,
          data: { messageTs: '1234567890.123456', permalink: 'https://slack.example.com/p1' },
        }),
      } as unknown as ApiClient

      registerSendSlackMessageTool(mockServer, mockClient)

      const result = await toolCallback({ channel: '#general', message: 'hello world' })

      expect((mockClient.sendSlackMessage as jest.Mock)).toHaveBeenCalledWith(
        '#general', 'hello world', undefined, expect.stringMatching(UUID_V4_REGEX),
      )
      expect(result).toEqual({
        content: [{
          type: 'text',
          text: JSON.stringify({ messageTs: '1234567890.123456', permalink: 'https://slack.example.com/p1' }, null, 2),
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
        sendSlackMessage: jest.fn().mockResolvedValue({ success: true, data: { messageTs: 'ts-1' } }),
      } as unknown as ApiClient

      registerSendSlackMessageTool(mockServer, mockClient)

      await toolCallback({ channel: '#general', message: 'reply', threadTs: '111.222' })

      expect((mockClient.sendSlackMessage as jest.Mock)).toHaveBeenCalledWith(
        '#general', 'reply', '111.222', expect.stringMatching(UUID_V4_REGEX),
      )
    })

    it('should generate a fresh callId (UUID v4) per invocation', async () => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        sendSlackMessage: jest.fn().mockResolvedValue({ success: true, data: { messageTs: 'ts-1' } }),
      } as unknown as ApiClient

      registerSendSlackMessageTool(mockServer, mockClient)

      await toolCallback({ channel: '#general', message: 'hello' })
      await toolCallback({ channel: '#general', message: 'world' })

      const mockFn = mockClient.sendSlackMessage as jest.Mock
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
        sendSlackMessage: jest.fn().mockResolvedValue({
          success: false,
          error: { code: 'SLACK_ERROR', message: 'channel_not_found' },
        }),
      } as unknown as ApiClient

      registerSendSlackMessageTool(mockServer, mockClient)

      const result = await toolCallback({ channel: '#missing', message: 'hello' })

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
        sendSlackMessage: jest.fn().mockResolvedValue({ success: false }),
      } as unknown as ApiClient

      registerSendSlackMessageTool(mockServer, mockClient)

      const result = await toolCallback({ channel: '#missing', message: 'hello' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Failed to send Slack message' }],
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
        sendSlackMessage: jest.fn().mockRejectedValue(new Error('network error')),
      } as unknown as ApiClient

      registerSendSlackMessageTool(mockServer, mockClient)

      const result = await toolCallback({ channel: '#general', message: 'hello' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: network error' }],
        isError: true,
      })
    })
  })
})
