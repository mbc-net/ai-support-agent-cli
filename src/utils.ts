import * as fs from 'fs'
import axios from 'axios'

import { logger } from './logger'

export function readJsonSync<T>(filePath: string): T {
  const content = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(content) as T
}

/**
 * 指定したミリ秒だけ待機する Promise を返す。
 * `await new Promise((resolve) => setTimeout(resolve, ms))` の重複イディオムを集約する。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function atomicWriteFile(filePath: string, content: string, mode = 0o600): void {
  const tmpPath = filePath + '.tmp'
  fs.writeFileSync(tmpPath, content, { mode })
  fs.renameSync(tmpPath, filePath)
}

/**
 * unknown な catch 値からメッセージ文字列を取り出す。
 * Error なら `.message`、それ以外は `String()` を返す。
 * `err instanceof Error ? err.message : String(err)` の重複イディオムを集約する。
 */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * unknown な catch 値を Error インスタンスに正規化する。
 * Error ならそのまま、それ以外は `String()` をメッセージにした Error を生成する。
 * `err instanceof Error ? err : new Error(String(err))` の重複イディオムを集約する。
 */
export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * エラーから詳細なメッセージを抽出する。
 * AxiosError の場合はレスポンスボディの message/error フィールドとHTTPステータスコードを含める。
 * それ以外の Error はメッセージを、非 Error は String() を返す。
 */
export function getErrorMessage(error: unknown): string {
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

  return toErrorMessage(error)
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

export function isAuthenticationError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false
  const status = error.response?.status
  return status === 401 || status === 403
}

/**
 * AxiosError のレスポンスデータが SSO_AUTH_REQUIRED エラーかどうかを判定する。
 *
 * AWS SSO 認証切れ時にサーバーが返す `error: 'SSO_AUTH_REQUIRED'` または
 * `errorCode: 'SSO_AUTH_REQUIRED'` フィールドを検出する。
 * 各モジュールで重複していた同一ロジックをここに集約する。
 */
export function isSsoAuthRequiredError(error: unknown): boolean {
  if (!axios.isAxiosError(error) || !error.response) return false
  const data = error.response.data as Record<string, unknown> | undefined
  if (!data) return false
  return data.error === 'SSO_AUTH_REQUIRED' || data.errorCode === 'SSO_AUTH_REQUIRED'
}

export function buildWsUrl(apiUrl: string, path: string): string {
  return apiUrl
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:')
    .replace(/\/$/, '') + path
}

/**
 * Returns true when the agent is running inside a Docker container.
 * Controlled by the AI_SUPPORT_AGENT_IN_DOCKER=1 environment variable,
 * which is injected by volume-mount-builder and the service templates.
 */
export function isInDocker(): boolean {
  return process.env.AI_SUPPORT_AGENT_IN_DOCKER === '1'
}

/**
 * Docker コンテナ内から host の URL にアクセスするため
 * localhost / 127.0.0.1 を host.docker.internal に変換する。
 * `AI_SUPPORT_AGENT_IN_DOCKER` が `'1'` のときのみ変換する。
 */
export function resolveUrlForDocker(url: string): string {
  if (!isInDocker()) return url
  return url.replace(
    /^((?:https?|wss?):\/\/)(localhost|127\.0\.0\.1)(:\d+)?/,
    (_, scheme: string, _host: string, port?: string) => `${scheme}host.docker.internal${port ?? ''}`,
  )
}

/**
 * Type guard for NodeJS.ErrnoException.
 * Narrows `unknown` catch values to ErrnoException and optionally checks the error code.
 * Avoids `instanceof Error` to stay compatible with Jest's `isolatedModules` environment
 * where filesystem errors may not pass the `instanceof` check.
 */
export function isErrnoException(err: unknown, code?: string): err is NodeJS.ErrnoException {
  if (err === null || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  if (typeof e['message'] !== 'string') return false
  if (!('code' in e)) return false
  return code === undefined || e['code'] === code
}

/**
 * エラーメッセージをログに出力してプロセスを終了する。
 *
 * `logger.error(msg)` + `process.exit(1)` のペアが agent-runner.ts / docker-runner.ts の
 * 複数箇所で繰り返されていたため集約する。
 */
export function exitWithError(message: string): never {
  logger.error(message)
  process.exit(1)
}
