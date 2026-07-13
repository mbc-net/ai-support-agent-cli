import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { KNOWLEDGE_AGENT_ID_ENV, KNOWLEDGE_COMMAND_ID_ENV } from '../config-writer'
import { mcpJsonResponse, newIdempotencyKey, withMcpErrorHandling } from './mcp-response'

/**
 * update_system_knowledge ツールを MCP サーバーに登録する
 *
 * システムのナレッジベース（api側DB）へ実際に登録・改訂する唯一の手段。ローカルファイルへの
 * 書き込みはナレッジ登録にはならないため、モデルが「ナレッジに反映して」という依頼をローカル
 * ファイル書き込みだけで済ませてしまわないよう、description で明示的に誘導する。
 *
 * 依頼者の実際の権限（`knowledgeCanPublish`/`knowledgeRequesterUserId`）は、このツールの
 * 呼び出し元では判定しない。旧設計ではリクエストボディの `canPublishHint` フィールドを
 * クライアント自己申告のまま信用しており、有効なagentサービストークンさえあればこれを
 * `true` に指定して承認ワークフローを完全にバイパスできてしまうCRITICALな脆弱性があった。
 * 現在は `commandId`（このナレッジ登録依頼の元になったチャットコマンドのID）と
 * `agentId`（エージェント自身のID）だけを渡し、api側で
 * `AgentCommandQueueService.getCommand(commandId, agentId, tenantCode)` により、コマンド
 * 生成時に刻印された本物の権限判定結果をサーバー側で引き当てる。省略時・レコード未検出時は
 * 安全側のdraftになる。`commandId`/`agentId` は
 * `AI_SUPPORT_AGENT_KNOWLEDGE_COMMAND_ID`/`AI_SUPPORT_AGENT_KNOWLEDGE_AGENT_ID` 環境変数
 * （config-writer.ts の per-command MCP 設定経由でこの MCP サーバー子プロセスへ明示的に
 * 渡される）から読み取る。LLM/モデルが自分で決めてよい値ではないため、ツールのスキーマ
 * （引数）には一切含めない。
 *
 * `callId` は呼び出しごとに生成する冪等性キー（`newIdempotencyKey()`。send_slack_message や
 * trigger_alarm と同じパターン）で、リトライ全体で同じ値を使うことで新規作成時の重複登録を
 * api側で防ぐ。
 */
export function registerUpdateSystemKnowledgeTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'update_system_knowledge',
    'Register or revise an entry in the system knowledge base (persisted in the backend database). '
      + 'You MUST use this tool whenever a user asks you to add or update the knowledge base — '
      + 'writing to a local file is NOT knowledge base registration and does not satisfy that request. '
      + 'Pass `id` to revise an existing entry, or omit it to create a new one. '
      + 'Whether the entry is published immediately or saved as a draft pending approval is determined '
      + 'server-side based on the requester\'s actual permissions — this tool does not accept a publish flag.',
    {
      id: z.string().optional().describe('Existing knowledge entry ID to revise. Omit to create a new entry.'),
      title: z.string().describe('Title (1-200 characters)'),
      content: z.string().describe('Content in Markdown'),
      category: z.string().describe('Category (max 50 characters)'),
      tags: z.array(z.string()).optional().describe('Tags'),
      sourceIssue: z.string().optional().describe('Related issue reference (max 50 characters)'),
    },
    async (args) => withMcpErrorHandling(async () => {
      const commandId = process.env[KNOWLEDGE_COMMAND_ID_ENV] || undefined
      const agentId = process.env[KNOWLEDGE_AGENT_ID_ENV] || undefined
      const callId = newIdempotencyKey()

      const result = await apiClient.updateSystemKnowledge({
        id: args.id,
        title: args.title,
        content: args.content,
        category: args.category,
        tags: args.tags,
        sourceIssue: args.sourceIssue,
        commandId,
        agentId,
        callId,
      })

      return mcpJsonResponse(result)
    }),
  )
}
