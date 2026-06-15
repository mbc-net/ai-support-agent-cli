import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { logger } from '../../logger'
import { isSsoAuthRequiredError } from '../../utils'
import { mcpErrorResponse, mcpJsonResponse, withMcpErrorHandling } from './mcp-response'

/**
 * get_credentials ツールを MCP サーバーに登録する
 *
 * セキュリティ設計:
 * - 認証情報はサーバーサイドで管理され、APIを通じてオンデマンドで取得する
 * - クライアント側にはシークレットを永続化しない（メモリ内のみ）
 * - API呼び出しにはBearerトークン認証が必要
 * - AWS認証情報は一時的なSTS資格情報（有効期限あり）
 * - DB認証情報はサーバー管理のSecureStringから取得
 */
export function registerCredentialsTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'get_credentials',
    'Get credentials for a service (AWS or database).',
    {
      type: z.enum(['aws', 'db']).describe('Credential type'),
      name: z.string().describe('Identifier (AWS account ID or DB connection name)'),
    },
    async ({ type, name }) => withMcpErrorHandling(async () => {
      if (type === 'aws') {
        try {
          const credentials = await apiClient.getAwsCredentials(name)
          return mcpJsonResponse({
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
            region: credentials.region,
          })
        } catch (error) {
          logger.debug(`[credentials] AWS credential error for ${name}: ${String(error)}`)
          if (isSsoAuthRequiredError(error)) {
            return mcpErrorResponse(
              `AWS SSO authentication has expired for account "${name}". ` +
              'Please re-authenticate via the admin console before retrying.',
            )
          }
          throw error
        }
      }

      if (type === 'db') {
        try {
          const credentials = await apiClient.getDbCredentials(name)
          return mcpJsonResponse(credentials)
        } catch (error) {
          logger.debug(`[credentials] DB credential error for ${name}: ${String(error)}`)
          throw error
        }
      }

      return mcpErrorResponse(`Unknown credential type: ${type}`)
    }),
  )
}
