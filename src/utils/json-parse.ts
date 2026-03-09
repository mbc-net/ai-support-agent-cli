/**
 * JSON.parse を安全に実行し、失敗時は undefined を返す
 */
export function safeJsonParse<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}
