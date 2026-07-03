import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { mcpErrorResponse, mcpJsonResponse, withMcpErrorHandling } from './mcp-response'

/** send_slack_message ツールを MCP サーバーに登録する */
export function registerSendSlackMessageTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'send_slack_message',
    'Send a message to Slack. Supports Slack markdown and thread replies.',
    {
      channel: z.string().describe('Target Slack channel name or ID'),
      message: z.string().describe('Message content (Slack markdown supported)'),
      threadTs: z.string().optional().describe('Thread timestamp to reply in a thread'),
    },
    async (args) => withMcpErrorHandling(async () => {
      // Generated once per logical invocation so HTTP retries of the same call reuse it (idempotency key)
      const callId = randomUUID()
      const result = await apiClient.sendSlackMessage(args.channel, args.message, args.threadTs, callId)
      if (!result.success) {
        return mcpErrorResponse(result.error?.message ?? 'Failed to send Slack message')
      }
      return mcpJsonResponse(result.data)
    }),
  )
}
