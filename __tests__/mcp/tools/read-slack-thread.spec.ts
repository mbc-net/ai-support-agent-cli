import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { logger } from '../../../src/logger'
import { registerReadSlackThreadTool } from '../../../src/mcp/tools/read-slack-thread'

jest.mock('../../../src/api-client')
jest.mock('../../../src/logger')

describe('read-slack-thread tool', () => {
  let toolCallback: () => Promise<unknown>
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  describe('registerReadSlackThreadTool', () => {
    it('should register the tool on the server with the expected name and schema', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerReadSlackThreadTool(mockServer, mockClient)

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'read_slack_thread',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })

    it('should register with an empty input schema (channel/threadTs must never be LLM-supplied — this is a security boundary against prompt-injection-driven arbitrary channel reads, not just an API convenience)', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerReadSlackThreadTool(mockServer, mockClient)

      const schemaArg = (mockServer.tool as jest.Mock).mock.calls[0][2]
      expect(schemaArg).toStrictEqual({})
      expect(Object.keys(schemaArg)).toHaveLength(0)
    })

    it('should read the Slack thread and return a JSON response on success', async () => {
      process.env.AI_SUPPORT_CONVERSATION_ID = 'conv-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        readSlackThread: jest.fn().mockResolvedValue({
          success: true,
          data: { text: '[2026/01/01 12:00] U012: hello\n[2026/01/01 12:05] AI: investigating' },
        }),
      } as unknown as ApiClient

      registerReadSlackThreadTool(mockServer, mockClient)

      const result = await toolCallback()

      expect((mockClient.readSlackThread as jest.Mock)).toHaveBeenCalledWith('conv-123')
      expect(result).toEqual({
        content: [{
          type: 'text',
          text: JSON.stringify({ text: '[2026/01/01 12:00] U012: hello\n[2026/01/01 12:05] AI: investigating' }, null, 2),
        }],
      })
      // No warning when data is present as expected.
      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('should return an mcpErrorResponse (not a silent {}) when the API reports success but omits data', async () => {
      // success:true with no data is a backend contract violation (the expected `text`
      // field is missing). Silently rounding to {} would be indistinguishable from "the
      // thread genuinely has no content" from the calling LLM's perspective — it must
      // surface as an error, not a normal empty result.
      process.env.AI_SUPPORT_CONVERSATION_ID = 'conv-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        readSlackThread: jest.fn().mockResolvedValue({ success: true }),
      } as unknown as ApiClient

      registerReadSlackThreadTool(mockServer, mockClient)

      const result = await toolCallback()

      expect(result).toEqual({
        content: [{
          type: 'text',
          text: 'Error: read_slack_thread: API returned success but no data (contract violation)',
        }],
        isError: true,
      })
      // Still operationally visible in logs, tagged with the conversation id for correlation.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('conv-123'))
    })

    it('should return an mcpErrorResponse when AI_SUPPORT_CONVERSATION_ID is not set', async () => {
      delete process.env.AI_SUPPORT_CONVERSATION_ID
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        readSlackThread: jest.fn(),
      } as unknown as ApiClient

      registerReadSlackThreadTool(mockServer, mockClient)

      const result = await toolCallback()

      expect((mockClient.readSlackThread as jest.Mock)).not.toHaveBeenCalled()
      expect(result).toEqual({
        content: [{
          type: 'text',
          text: expect.stringContaining('AI_SUPPORT_CONVERSATION_ID'),
        }],
        isError: true,
      })
    })

    it('should return an mcpErrorResponse when the API reports failure', async () => {
      process.env.AI_SUPPORT_CONVERSATION_ID = 'conv-not-slack'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        readSlackThread: jest.fn().mockResolvedValue({
          success: false,
          error: { code: 'NOT_FOUND', message: 'このスレッドはSlack会話に紐づいていません' },
        }),
      } as unknown as ApiClient

      registerReadSlackThreadTool(mockServer, mockClient)

      const result = await toolCallback()

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: このスレッドはSlack会話に紐づいていません' }],
        isError: true,
      })
    })

    it('should fall back to a default error message when the API omits error details', async () => {
      process.env.AI_SUPPORT_CONVERSATION_ID = 'conv-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        readSlackThread: jest.fn().mockResolvedValue({ success: false }),
      } as unknown as ApiClient

      registerReadSlackThreadTool(mockServer, mockClient)

      const result = await toolCallback()

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Failed to read Slack thread' }],
        isError: true,
      })
    })

    it('should handle exceptions thrown by the API client', async () => {
      process.env.AI_SUPPORT_CONVERSATION_ID = 'conv-123'
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        readSlackThread: jest.fn().mockRejectedValue(new Error('network error')),
      } as unknown as ApiClient

      registerReadSlackThreadTool(mockServer, mockClient)

      const result = await toolCallback()

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: network error' }],
        isError: true,
      })
    })
  })
})
