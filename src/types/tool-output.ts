/**
 * Common error shape returned by agent-tool endpoints
 * (`POST /api/{tenantCode}/agent/tools/*`) on failure.
 */
export interface ToolOutputError {
  code: string
  message: string
}

export interface SendSlackMessageResult {
  success: boolean
  data?: { messageTs?: string; permalink?: string }
  error?: ToolOutputError
}

export interface SendSlackFileResult {
  success: boolean
  data?: { messageTs?: string; permalink?: string; fileId?: string }
  error?: ToolOutputError
}

export interface TriggerAlarmResult {
  success: boolean
  data?: { alertNumber?: string; status?: 'created' | 'duplicate' | 'failed' }
  error?: ToolOutputError
}

/**
 * `read_slack_thread` Agent MCP ツールの結果。
 *
 * `data.text` は現在のSlackスレッドの整形済み全文（自ボットの過去投稿を含み、
 * 他アプリのBotメッセージは除外）。会話IDがSlack会話に紐づかない場合は
 * `error.code === 'NOT_FOUND'` を返す。
 */
export interface ReadSlackThreadResult {
  success: boolean
  data?: { text: string }
  error?: ToolOutputError
}

/**
 * `trigger_e2e_test` Agent MCP ツールの結果。
 *
 * タスク実行中に呼び出された場合、起動した E2E 実行に taskId が紐付き、
 * タスク詳細画面の E2E テストタブから逆引きできるようになる。
 */
export interface TriggerE2eTestResult {
  success: boolean
  data?: { executionId?: string; dispatched?: boolean }
  error?: ToolOutputError
}

/**
 * `update_system_knowledge` Agent MCP ツールが `POST /api/{tenantCode}/agent/knowledge` に
 * 送るリクエストボディ。
 *
 * `canPublishHint`/`requesterUserId`/`projectCode` を生のリクエストフィールドとしてそのまま
 * 信用する旧設計には、有効なagentサービストークンさえあればリクエストボディに
 * `canPublishHint: true` を直接指定して承認ワークフローを完全にバイパスできてしまう
 * CRITICALな権限バイパス脆弱性があった。api側はこれを修正し、信頼の起点を
 * 「クライアント自己申告のcanPublishHint」から「サーバー側で発行済みのチャットコマンド
 * レコードの参照」に変更した。
 *
 * `commandId`/`agentId` はツールのスキーマ（LLMが指定できるパラメータ）には含まれない。
 * agent側が config-writer.ts 経由でMCPサブプロセスの環境変数
 * （`AI_SUPPORT_AGENT_KNOWLEDGE_COMMAND_ID`/`AI_SUPPORT_AGENT_KNOWLEDGE_AGENT_ID`）へ伝搬し、
 * ツール実装（`update-system-knowledge.ts`）がそこから読み取ってここに詰める。api側はこの
 * `commandId`/`agentId` で `AgentCommandQueueService.getCommand(commandId, agentId,
 * tenantCode)` を引き、コマンド生成時に刻印された本物の `knowledgeCanPublish`/
 * `knowledgeRequesterUserId` を引き当てる。省略時、またはレコードが見つからない場合は
 * 安全側のdraftになる。`projectCode` はもはやリクエストボディで受け付けず、常にトークン
 * 自体のスコープ（`AgentAuthInfo.projectCode`）が使われる。
 */
export interface UpdateSystemKnowledgeRequest {
  /** 指定時は改訂、未指定時は新規作成 */
  id?: string
  title: string
  content: string
  category: string
  tags?: string[]
  sourceIssue?: string
  /**
   * このナレッジ登録依頼の元になったチャットコマンドのID。api側の
   * `AgentCommandQueueService.getCommand` によるコマンドレコード引き当てに使う。
   */
  commandId?: string
  /** 上記コマンドレコード引き当て用のエージェント自身のagentId */
  agentId?: string
  /** 冪等性キー。新規作成時、同一callIdでのリトライは同一のナレッジIDとして扱われる */
  callId?: string
}

/**
 * `update_system_knowledge` Agent MCP ツールの結果（`POST /api/{tenantCode}/agent/knowledge` の
 * レスポンスをそのまま返す）。他の `agent/tools/*` エンドポイントと異なり
 * `{success, data, error}` ではなく、201でナレッジ詳細オブジェクトを直接返す。
 */
export interface UpdateSystemKnowledgeResult {
  id: string
  tenantCode?: string
  projectCode?: string
  category?: string
  title?: string
  content?: string
  tags?: string[]
  sourceIssue?: string
  /**
   * サーバー側で `commandId`/`agentId` から引き当てた実際の knowledgeCanPublish が
   * trueの場合は即時公開(published)、それ以外（省略時・コマンドレコード未検出を含む）は
   * 承認待ちのdraft
   */
  status?: 'published' | 'draft'
  createdAt?: string
  updatedAt?: string
}
