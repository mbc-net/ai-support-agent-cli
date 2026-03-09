/**
 * 改行区切りのストリームデータをバッファリングし、完全な行ごとにコールバックを呼び出す
 * NDJSON や SSE のパースに使用
 */
export class StreamLineParser {
  private buffer = ''

  /**
   * データチャンクを追加し、完全な行をコールバックで返す
   */
  push(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk
    const lines = this.buffer.split('\n')
    // 最後の不完全な行はバッファに残す
    this.buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) {
        onLine(trimmed)
      }
    }
  }

  /** バッファをリセット */
  reset(): void {
    this.buffer = ''
  }
}
