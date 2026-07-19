/**
 * セッションID安全性検証
 *
 * terminal セッションの sessionId は WebSocket 経由で API/クライアントから渡ってくる。
 * この値は `TerminalSession` 内で以下の用途に使われる:
 *   - tmp ディレクトリ上の SSH 鍵ファイルパス生成 (`path.join(os.tmpdir(), \`ssh-key-${sessionId}\`)`)
 *   - そのパスを `GIT_SSH_COMMAND` 環境変数に埋め込む文字列展開
 *
 * 文字種を制限しないと、シェルメタ文字（`;`, `|`, `` ` ``, `$()` 等）や
 * path traversal（`../`）を含む sessionId がコマンドインジェクション/パストラバーサルの
 * 原因になる。英数字・ハイフン・アンダースコアのみを許可することでこれを防ぐ。
 */

const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const MAX_SESSION_ID_LENGTH = 100

/**
 * sessionId が安全な文字集合（英数字・ハイフン・アンダースコアのみ）で構成され、
 * 空文字列でも長すぎもしないかを検証する。
 */
export function isSafeSessionId(id: string): boolean {
  if (!id) return false
  if (id.length > MAX_SESSION_ID_LENGTH) return false
  return SAFE_SESSION_ID_PATTERN.test(id)
}
