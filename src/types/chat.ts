export interface HistoryMessage {
  role: string
  content: string
}

export interface ChatPayload {
  message?: unknown
  conversationId?: unknown
  projectCode?: unknown
  history?: unknown
  locale?: unknown
  awsAccountId?: unknown
  files?: unknown
  conversationFiles?: unknown
  browserSessionId?: unknown
  agentChatMode?: unknown
  interactionOrigin?: unknown
  toolPolicy?: unknown
  /** タスク実行中のタスクID（タスク詳細のE2Eテストタブ逆引き用。trigger_e2e_testツールがE2E実行に紐付ける） */
  taskId?: unknown
  /**
   * 埋め込みウィジェットのページコンテキスト（機能: 外部エージェント経路への
   * ページコンテキスト配線）。閲覧中ページの url/title/content/user。サーバ由来だが
   * 中身（特に content）は埋め込み先サイト由来の**非信頼データ**であり、
   * buildPageContextNotice で untrusted な参考情報ブロックとして反映する。
   */
  pageContext?: unknown
  policyContext?: {
    e2eExecutionId?: string
    e2eTestCaseId?: string
    [key: string]: unknown
  }
}

/**
 * パース済みページコンテキスト（機能: 外部エージェント経路へのページコンテキスト配線）。
 */
export interface PageContextInfo {
  url?: string
  title?: string
  content?: string
  user?: {
    name?: string
    email?: string
    groups?: string[]
  }
}

export interface ChatFileInfo {
  fileId: string
  s3Key: string
  filename: string
  contentType: string
  fileSize: number
}

export type ChatChunkType =
  | 'delta'
  | 'tool_call'
  | 'tool_result'
  | 'done'
  | 'error'
  | 'system'
  | 'file_attachment'

export interface ChatChunk {
  index: number
  type: ChatChunkType
  content: string
}
