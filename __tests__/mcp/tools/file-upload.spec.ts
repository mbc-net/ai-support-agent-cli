import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerFileUploadTool } from '../../../src/mcp/tools/file-upload'

jest.mock('../../../src/api-client')
jest.mock('../../../src/logger')
jest.mock('../../../src/commands/file-transfer', () => ({
  uploadFile: jest.fn(),
  getContentType: jest.fn().mockReturnValue('text/plain'),
  ALLOWED_EXTENSIONS: new Set(['.txt', '.json']),
}))

describe('file-upload tool', () => {
  let toolCallback: (args: {
    filePath: string
    filename: string
    conversationId: string
    messageId: string
    projectCode: string
  }) => Promise<unknown>

  function setupTool(mockClient: Partial<ApiClient>) {
    const mockServer = {
      tool: jest.fn().mockImplementation(
        (_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        },
      ),
    } as unknown as McpServer

    registerFileUploadTool(mockServer, mockClient as ApiClient)
  }

  describe('registerFileUploadTool', () => {
    it('should register the tool on the server', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerFileUploadTool(mockServer, mockClient)

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'file_upload',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })
  })

  describe('successful upload', () => {
    it('should upload file and return success response', async () => {
      const { uploadFile } = require('../../../src/commands/file-transfer')
      ;(uploadFile as jest.Mock).mockResolvedValue({
        fileId: 'file-123',
        s3Key: 'uploads/file-123.txt',
      })

      setupTool({})

      const result = await toolCallback({
        filePath: '/tmp/test.txt',
        filename: 'test.txt',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        projectCode: 'TEST_01',
      }) as { content: Array<{ text: string }> }

      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.success).toBe(true)
      expect(parsed.fileId).toBe('file-123')
      expect(parsed.s3Key).toBe('uploads/file-123.txt')
      expect(parsed.filename).toBe('test.txt')
      expect(parsed.contentType).toBe('text/plain')
    })
  })

  describe('error handling', () => {
    it('should handle upload errors', async () => {
      const { uploadFile } = require('../../../src/commands/file-transfer')
      ;(uploadFile as jest.Mock).mockRejectedValue(new Error('Upload failed'))

      setupTool({})

      const result = await toolCallback({
        filePath: '/tmp/test.txt',
        filename: 'test.txt',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        projectCode: 'TEST_01',
      })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Upload failed' }],
        isError: true,
      })
    })

    it('should handle non-Error throws', async () => {
      const { uploadFile } = require('../../../src/commands/file-transfer')
      ;(uploadFile as jest.Mock).mockRejectedValue('string error')

      setupTool({})

      const result = await toolCallback({
        filePath: '/tmp/test.txt',
        filename: 'test.txt',
        conversationId: 'conv-1',
        messageId: 'msg-1',
        projectCode: 'TEST_01',
      })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: string error' }],
        isError: true,
      })
    })
  })
})
