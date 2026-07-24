/** Anthropic API のトークン使用量 */
export interface ApiUsage {
  inputTokens: number
  outputTokens: number
}

/** callAnthropicApi の戻り値 */
export interface ApiChatResult {
  text: string
  usage: ApiUsage
}

/** Anthropic Messages API の tools フィールドに渡すツール定義（JSON Schema サブセット） */
export interface AnthropicToolSchema {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }
}

/** Anthropic Messages API へのリクエストに含める assistant/user content ブロック */
export interface AnthropicTextBlock {
  type: 'text'
  text: string
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

export type AnthropicRequestContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

/** Anthropic Messages API のリクエストメッセージ（tool-use往復時は content が配列になる） */
export interface AnthropicRequestMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicRequestContentBlock[]
}

/** ツール実行1件分（tool_use ブロックから抽出した呼び出し要求） */
export interface AnthropicToolUseRequest {
  id: string
  name: string
  input: Record<string, unknown>
}

/** Anthropic SSE ストリーミングイベント型 */
export interface AnthropicMessageStartEvent {
  type: 'message_start'
  message?: { usage?: { input_tokens?: number } }
}

export interface AnthropicMessageDeltaEvent {
  type: 'message_delta'
  delta?: { stop_reason?: string | null }
  usage?: { output_tokens?: number }
}

export interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta'
  index?: number
  delta?: { type: string; text?: string; partial_json?: string }
}

export interface AnthropicContentBlockStartEvent {
  type: 'content_block_start'
  index?: number
  content_block?: { type: string; name?: string; id?: string; input?: Record<string, unknown> }
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicMessageDeltaEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStartEvent
