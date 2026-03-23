import { getErrorMessage } from '../../utils'

export { getErrorMessage }

type McpContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export type McpToolResult =
  | ReturnType<typeof mcpTextResponse>
  | ReturnType<typeof mcpErrorResponse>
  | ReturnType<typeof mcpImageResponse>
  | ReturnType<typeof mcpTextImageResponse>

export function mcpTextResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function mcpErrorResponse(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const }
}

export function mcpImageResponse(base64Data: string, mimeType: string) {
  return { content: [{ type: 'image' as const, data: base64Data, mimeType }] }
}

export function mcpTextImageResponse(text: string, base64Data: string, mimeType: string) {
  return {
    content: [
      { type: 'text' as const, text },
      { type: 'image' as const, data: base64Data, mimeType },
    ] as McpContentItem[],
  }
}

/**
 * MCP ツールハンドラのエラーハンドリングラッパー。
 * ツール実装関数を受け取り、例外発生時に `mcpErrorResponse` へ変換して返す。
 * AxiosError の場合はHTTPステータスとサーバーメッセージも含めた詳細なエラーを返す。
 *
 * @example
 * server.tool('my_tool', schema, async (args) =>
 *   withMcpErrorHandling(async () => {
 *     const data = await fetchSomething(args)
 *     return mcpTextResponse(data)
 *   }),
 * )
 */
export async function withMcpErrorHandling(
  fn: () => Promise<McpToolResult>,
): Promise<McpToolResult> {
  try {
    return await fn()
  } catch (error) {
    return mcpErrorResponse(getErrorMessage(error))
  }
}
