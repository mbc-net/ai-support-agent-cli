import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { ApiClient } from '../api-client'
import { ENV_VARS } from '../constants'
import {
  ASSIGNMENT_GENERATION_ENV,
  ASSIGNMENT_INSTANCE_ID_ENV,
  KNOWLEDGE_COMMAND_ID_ENV,
} from './config-writer'
import { registerBrowserTools } from './tools/browser'
import { registerE2eTestStepTool } from './tools/e2e-test-step'
import { BrowserSessionManager } from './tools/browser/browser-session-manager'
import { registerCredentialsTool } from './tools/credentials'
import { registerDbQueryTool } from './tools/db-query'
import { registerDbSchemasTool } from './tools/db-schemas'
import { registerFileUploadTool } from './tools/file-upload'
import { registerProjectInfoTool } from './tools/project-info'
import { registerReadConversationFileTool } from './tools/read-conversation-file'
import { registerReadSlackThreadTool } from './tools/read-slack-thread'
import { registerSendSlackFileTool } from './tools/send-slack-file'
import { registerSendSlackMessageTool } from './tools/send-slack-message'
import { registerTriggerAlarmTool } from './tools/trigger-alarm'
import { registerTriggerE2eTestTool } from './tools/trigger-e2e-test'
import { registerUpdateSystemKnowledgeTool } from './tools/update-system-knowledge'

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
  registerSendSlackMessageTool(server, apiClient)
  registerSendSlackFileTool(server, apiClient)
  registerTriggerAlarmTool(server, apiClient)
  registerReadSlackThreadTool(server, apiClient)
  registerTriggerE2eTestTool(server, apiClient)
  registerUpdateSystemKnowledgeTool(server, apiClient)
  // browser_navigate/browser_click等とreport_test_stepが同じBrowserSessionManagerを
  // 参照するように、ここで一つだけ生成して両方に渡す（渡さないと、report_test_step が
  // アクティブなセッションを解決できず、常に白紙のスクリーンショットを撮ってしまう）。
  const manager = browserSessionManager ?? new BrowserSessionManager()
  const browserSession = registerBrowserTools(server, apiClient, manager)
  registerE2eTestStepTool(server, apiClient, browserSession, manager)

  return server
}

/**
 * MCP サーバーを stdio transport で起動する
 */
export async function startMcpServer(): Promise<void> {
  const apiUrl = process.env[ENV_VARS.API_URL]
  const token = process.env[ENV_VARS.TOKEN]
  const projectCode = process.env[ENV_VARS.PROJECT_CODE]
  const tenantCode = process.env[ENV_VARS.TENANT_CODE]

  if (!apiUrl || !token || !projectCode) {
    const missing = []
    if (!apiUrl) missing.push(ENV_VARS.API_URL)
    if (!token) missing.push(ENV_VARS.TOKEN)
    if (!projectCode) missing.push(ENV_VARS.PROJECT_CODE)
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  // The parent process passes the assignment it holds for this command
  // (see ASSIGNMENT_INSTANCE_ID_ENV). Without it this child would resolve a
  // different instance id via the HOSTNAME fallback and hold no generation, so
  // every knowledge write for an assigned command would be fenced out (409).
  const assignmentInstanceId = process.env[ASSIGNMENT_INSTANCE_ID_ENV]
  const assignmentGeneration = Number(process.env[ASSIGNMENT_GENERATION_ENV])
  const knowledgeCommandId = process.env[KNOWLEDGE_COMMAND_ID_ENV]
  const apiClient = new ApiClient(
    apiUrl,
    token,
    assignmentInstanceId ? { instanceId: assignmentInstanceId } : undefined,
  )
  if (
    assignmentInstanceId &&
    knowledgeCommandId &&
    Number.isInteger(assignmentGeneration) &&
    assignmentGeneration >= 1
  ) {
    apiClient.restoreAssignment(knowledgeCommandId, assignmentGeneration)
  }
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
