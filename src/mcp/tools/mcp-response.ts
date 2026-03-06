import { getErrorMessage } from '../../utils'

export { getErrorMessage }

export type McpToolResult = ReturnType<typeof mcpTextResponse> | ReturnType<typeof mcpErrorResponse>

export function mcpTextResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function mcpErrorResponse(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const }
}

export async function withMcpErrorHandling(
  fn: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
  try {
    return await fn()
  } catch (error) {
    return mcpErrorResponse(getErrorMessage(error))
  }
}
