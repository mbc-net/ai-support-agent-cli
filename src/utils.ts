import * as fs from 'fs'
import axios from 'axios'

export function atomicWriteFile(filePath: string, content: string, mode = 0o600): void {
  const tmpPath = filePath + '.tmp'
  fs.writeFileSync(tmpPath, content, { mode })
  fs.renameSync(tmpPath, filePath)
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function parseString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  return null
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && !isNaN(value)) return value
  return null
}

export function truncateString(text: string, limit: number, suffix = '...'): string {
  if (text.length <= limit) return text
  return text.substring(0, limit) + suffix
}

export function validateApiUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return `Invalid protocol: ${parsed.protocol}. Only http: and https: are allowed`
    }
    return null
  } catch {
    return `Invalid URL: ${url}`
  }
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

export function isAuthenticationError(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401
}
