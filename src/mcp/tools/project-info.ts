import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../api-client'
import { extractErrorMessage, mcpErrorResponse, mcpTextResponse } from './mcp-response'

/** get_project_info ツールを MCP サーバーに登録する */
export function registerProjectInfoTool(
  server: McpServer,
  apiClient: ApiClient,
  projectCode: string,
): void {
  server.tool(
    'get_project_info',
    'Get project configuration information including databases, AWS accounts, and documentation sources.',
    {},
    async () => {
      try {
        const config = await apiClient.getProjectConfig()

        const info: Record<string, unknown> = {
          project: config.project,
        }

        if (config.databases?.length) {
          info.databases = config.databases.map((db) => ({
            name: db.name,
            engine: db.engine,
            host: db.host,
            port: db.port,
            database: db.database,
            writePermissions: db.writePermissions,
          }))
        }

        if (config.aws?.accounts?.length) {
          info.awsAccounts = config.aws.accounts.map((acc) => ({
            id: acc.id,
            name: acc.name,
            region: acc.region,
            accountId: acc.accountId,
            isDefault: acc.isDefault,
          }))
        }

        if (config.documentation?.sources?.length) {
          info.documentation = config.documentation
        }

        info.projectCode = projectCode

        return mcpTextResponse(JSON.stringify(info, null, 2))
      } catch (error) {
        return mcpErrorResponse(extractErrorMessage(error))
      }
    },
  )
}
