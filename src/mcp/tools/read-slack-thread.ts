import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../api-client'
import { logger } from '../../logger'
import { CONVERSATION_ID_ENV } from '../config-writer'
import { mcpErrorResponse, mcpJsonResponse, withMcpErrorHandling } from './mcp-response'

/**
 * read_slack_thread ツールを MCP サーバーに登録する。
 *
 * channel/threadTs はクライアント（LLM）から受け取らず、サーバー側で
 * `AI_SUPPORT_CONVERSATION_ID` 環境変数（現在の会話ID）から Slackスレッドへ
 * 逆引きする。
 *
 * 注意（ゲート条件と実際のSlack限定性の違い）: このツールがローカルで判定できるのは
 * `AI_SUPPORT_CONVERSATION_ID` が設定されているか否かのみであり、これは Slack 由来の
 * チャットコマンドに限らず conversationId を持つ他の会話（例: Web チャット）でも
 * 設定されうる。「実際にSlackスレッドに紐づいているか」はサーバー側
 * （`SlackConversationService.findThreadByConversationId`）でのみ判定され、
 * 紐づかない場合は `NOT_FOUND` エラーとして返る。したがって本ツールは
 * 「Slack起源であることが確定している場合のみ利用可能」ではなく、「conversationId
 * があれば試行し、Slackスレッドに紐づかなければサーバー側エラーになる」という
 * 挙動になる。
 */
export function registerReadSlackThreadTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'read_slack_thread',
    'Read the full text of the conversation thread currently being processed (channel/thread resolved server-side from AI_SUPPORT_CONVERSATION_ID), including this bot\'s own past posts. Takes no arguments. Requires the current chat command to carry a conversation id; if that conversation is not backed by a Slack thread, the underlying API returns a NOT_FOUND error.',
    {},
    async () => withMcpErrorHandling(async () => {
      const chatConversationId = process.env[CONVERSATION_ID_ENV]
      if (!chatConversationId) {
        return mcpErrorResponse(
          `${CONVERSATION_ID_ENV} is not set. This tool requires the current chat command to carry a conversation id.`,
        )
      }

      const result = await apiClient.readSlackThread(chatConversationId)
      if (!result.success) {
        return mcpErrorResponse(result.error?.message ?? 'Failed to read Slack thread')
      }
      if (!result.data) {
        // success:true と data 欠落の組み合わせはバックエンド契約違反（本来あるべき
        // text フィールドの欠落）であり、「スレッドが実際に空」とは運用上区別できない。
        // 呼び出し元（LLM）から見て正常系の空応答と誤認されないよう、エラーとして
        // 返す（黙って {} に丸めない）。識別子付きで警告ログも残す。
        logger.warn(`[read_slack_thread] API reported success but omitted data for chatConversationId=${chatConversationId}`)
        return mcpErrorResponse('read_slack_thread: API returned success but no data (contract violation)')
      }
      return mcpJsonResponse(result.data)
    }),
  )
}
