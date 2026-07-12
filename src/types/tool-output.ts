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
