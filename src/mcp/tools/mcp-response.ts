import axios from 'axios'

import { getErrorMessage } from '../../utils'

export { getErrorMessage }

export type McpToolResult =
  | ReturnType<typeof mcpTextResponse>
  | ReturnType<typeof mcpErrorResponse>
  | ReturnType<typeof mcpImageResponse>

export function mcpTextResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

export function mcpErrorResponse(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const }
}

export function mcpImageResponse(base64Data: string, mimeType: string) {
  return { content: [{ type: 'image' as const, data: base64Data, mimeType }] }
}

/**
 * エラーから詳細なメッセージを抽出する。
 * AxiosError の場合はレスポンスボディの message/error フィールドとHTTPステータスコードを含める。
 */
export function getDetailedErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error) && error.response) {
    const status = error.response.status
    const data = error.response.data as Record<string, unknown> | undefined

    if (data) {
      const serverMessage = data.message ?? data.error
      if (serverMessage) {
        return `[${status}] ${serverMessage}`
      }
    }

    return `HTTP ${status}: ${error.message}`
  }

  return getErrorMessage(error)
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
    return mcpErrorResponse(getDetailedErrorMessage(error))
  }
}
