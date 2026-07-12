import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { mcpErrorResponse, mcpJsonResponse, newIdempotencyKey, withMcpErrorHandling } from './mcp-response'

/** send_slack_file ツールを MCP サーバーに登録する */
export function registerSendSlackFileTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'send_slack_file',
    'Send a file (e.g. CSV or other text files) as a real attachment to Slack.',
    {
      channel: z.string().describe('Target Slack channel name or ID'),
      fileName: z.string().describe('File name including extension (e.g. cost.csv)'),
      content: z.string().describe('File content (text/CSV string)'),
      threadTs: z.string().optional().describe('Thread timestamp to reply in a thread'),
    },
    async (args) => withMcpErrorHandling(async () => {
      const callId = newIdempotencyKey()
      const result = await apiClient.sendSlackFile(args.channel, args.fileName, args.content, args.threadTs, callId)
      if (!result.success) {
        return mcpErrorResponse(result.error?.message ?? 'Failed to send Slack file')
      }
      return mcpJsonResponse(result.data)
    }),
  )
}
