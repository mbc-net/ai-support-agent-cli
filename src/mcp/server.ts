import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { ApiClient } from '../api-client'
import { registerBrowserTools } from './tools/browser'
import { BrowserSessionManager } from './tools/browser/browser-session-manager'
import { registerCredentialsTool } from './tools/credentials'
import { registerDbQueryTool } from './tools/db-query'
import { registerDbSchemasTool } from './tools/db-schemas'
import { registerFileUploadTool } from './tools/file-upload'
import { registerProjectInfoTool } from './tools/project-info'
import { registerReadConversationFileTool } from './tools/read-conversation-file'

/**
 * MCP サーバーを作成する
 */
export function createMcpServer(apiClient: ApiClient, projectCode: string, browserSessionManager?: BrowserSessionManager): McpServer {
  const server = new McpServer({
    name: 'ai-support-agent',
    version: '1.0.0',
  })

  registerDbQueryTool(server, apiClient)
  registerDbSchemasTool(server, apiClient)
  registerCredentialsTool(server, apiClient)
  registerFileUploadTool(server, apiClient)
  registerProjectInfoTool(server, apiClient, projectCode)
  registerReadConversationFileTool(server, apiClient)
  registerBrowserTools(server, apiClient, browserSessionManager)

  return server
}

/**
 * MCP サーバーを stdio transport で起動する
 */
export async function startMcpServer(): Promise<void> {
  const apiUrl = process.env.AI_SUPPORT_AGENT_API_URL
  const token = process.env.AI_SUPPORT_AGENT_TOKEN
  const projectCode = process.env.AI_SUPPORT_AGENT_PROJECT_CODE
  const tenantCode = process.env.AI_SUPPORT_AGENT_TENANT_CODE

  if (!apiUrl || !token || !projectCode) {
    const missing = []
    if (!apiUrl) missing.push('AI_SUPPORT_AGENT_API_URL')
    if (!token) missing.push('AI_SUPPORT_AGENT_TOKEN')
    if (!projectCode) missing.push('AI_SUPPORT_AGENT_PROJECT_CODE')
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  const apiClient = new ApiClient(apiUrl, token)
  if (tenantCode) {
    apiClient.setTenantCode(tenantCode)
  }
  apiClient.setProjectCode(projectCode)
  const server = createMcpServer(apiClient, projectCode)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// When executed directly
if (require.main === module) {
  startMcpServer().catch((error) => {
    process.stderr.write(`MCP server error: ${error}\n`)
    process.exit(1)
  })
}
