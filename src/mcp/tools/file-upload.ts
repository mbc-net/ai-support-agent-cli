import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { ALLOWED_EXTENSIONS, getContentType, uploadFile } from '../../commands/file-transfer'
import { extractErrorMessage, mcpErrorResponse, mcpTextResponse } from './mcp-response'

/**
 * file_upload ツールを MCP サーバーに登録する
 *
 * ファイルを presigned URL 経由で S3 にアップロードする
 */
export function registerFileUploadTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'file_upload',
    `Upload a file to the chat conversation. Allowed extensions: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
    {
      filePath: z.string().describe('Absolute path to the file to upload'),
      filename: z.string().describe('Display name for the file'),
      conversationId: z.string().describe('Conversation ID'),
      messageId: z.string().describe('Message ID'),
      projectCode: z.string().describe('Project code'),
    },
    async ({ filePath, filename, conversationId, messageId, projectCode }) => {
      try {
        const { fileId, s3Key, fileSize } = await uploadFile(
          apiClient,
          filePath,
          filename,
          conversationId,
          messageId,
          projectCode,
        )

        const contentType = getContentType(filename)
        return mcpTextResponse(JSON.stringify({
          success: true,
          fileId,
          s3Key,
          filename,
          contentType,
          fileSize,
        }, null, 2))
      } catch (error) {
        return mcpErrorResponse(extractErrorMessage(error))
      }
    },
  )
}
