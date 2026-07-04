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
