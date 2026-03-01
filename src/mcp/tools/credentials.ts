import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { extractErrorMessage, mcpErrorResponse, mcpTextResponse } from './mcp-response'

/** get_credentials ツールを MCP サーバーに登録する */
export function registerCredentialsTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'get_credentials',
    'Get credentials for a service (AWS or database).',
    {
      type: z.enum(['aws', 'db']).describe('Credential type'),
      name: z.string().describe('Identifier (AWS account ID or DB connection name)'),
    },
    async ({ type, name }) => {
      try {
        if (type === 'aws') {
          const credentials = await apiClient.getAwsCredentials(name)
          return mcpTextResponse(JSON.stringify({
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
            region: credentials.region,
          }, null, 2))
        }

        if (type === 'db') {
          const credentials = await apiClient.getDbCredentials(name)
          return mcpTextResponse(JSON.stringify(credentials, null, 2))
        }

        return mcpErrorResponse(`Unknown credential type: ${type}`)
      } catch (error) {
        return mcpErrorResponse(extractErrorMessage(error))
      }
    },
  )
}
