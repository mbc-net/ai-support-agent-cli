import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { mcpErrorResponse, mcpJsonResponse, newIdempotencyKey, withMcpErrorHandling } from './mcp-response'

/** trigger_alarm ツールを MCP サーバーに登録する */
export function registerTriggerAlarmTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'trigger_alarm',
    'Trigger an AI SOS-equivalent emergency alarm immediately (no confirmation) when you detect a real incident '
      + 'during task execution. This may have side effects such as phone calls or workflow execution. '
      + 'Only use for genuine emergencies.',
    {
      title: z.string().describe('Alarm title'),
      reason: z.string().describe('Description of the situation'),
      priority: z.enum(['urgent', 'high', 'medium', 'low']).optional().describe('Priority (default: urgent)'),
    },
    async (args) => withMcpErrorHandling(async () => {
      const callId = newIdempotencyKey()
      const result = await apiClient.triggerAlarm(args.title, args.reason, args.priority, callId)
      if (!result.success) {
        return mcpErrorResponse(result.error?.message ?? 'Failed to trigger alarm')
      }
      return mcpJsonResponse(result.data)
    }),
  )
}
