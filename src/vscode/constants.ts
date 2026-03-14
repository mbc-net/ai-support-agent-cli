/** code-server アイドルタイムアウト（10分） */
export const VSCODE_IDLE_TIMEOUT_MS = 10 * 60 * 1000

/** code-server のデフォルトポート */
export const VSCODE_DEFAULT_PORT = 8443

/** code-server のバインドホスト（外部からアクセス不可） */
export const VSCODE_BIND_HOST = '127.0.0.1'

/** WebSocket 再接続ベース遅延 */
export const VSCODE_WS_RECONNECT_BASE_DELAY_MS = 1000

/** WebSocket 最大再接続リトライ */
export const VSCODE_WS_MAX_RECONNECT_RETRIES = 5

/** HTTP レスポンスボディのチャンクサイズ（512KB） */
export const HTTP_RESPONSE_CHUNK_SIZE = 512 * 1024

/** ヘルスチェック間隔（30秒） */
export const HEALTH_CHECK_INTERVAL_MS = 30 * 1000

/** code-server 起動タイムアウト（30秒） */
export const STARTUP_TIMEOUT_MS = 30 * 1000
