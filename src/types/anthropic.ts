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

/** Anthropic SSE ストリーミングイベント型 */
export interface AnthropicMessageStartEvent {
  type: 'message_start'
  message?: { usage?: { input_tokens?: number } }
}

export interface AnthropicMessageDeltaEvent {
  type: 'message_delta'
  usage?: { output_tokens?: number }
}

export interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta'
  delta?: { type: string; text?: string }
}

export interface AnthropicContentBlockStartEvent {
  type: 'content_block_start'
  content_block?: { type: string; name?: string }
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicMessageDeltaEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStartEvent
