import * as fs from 'fs'

/**
 * 小さなマーカー/状態ファイル（docker-built-hash、registered-agent-id 等）を
 * 読み取り、内容を `trim()` して返す。
 *
 * 読み取りに失敗した場合（ファイル未作成・アクセス不可など）は `undefined` を返す。
 * 内容が空文字のときは `''`（`undefined` ではない）を返すため、呼び出し側は
 * 「未読み取り（undefined）」と「空（''）」を区別しつつ従来どおりの条件分岐で扱える。
 */
export function readMarkerFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch {
    return undefined
  }
}
