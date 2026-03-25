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
  policyContext?: {
    e2eExecutionId?: string
    e2eTestCaseId?: string
    [key: string]: unknown
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
