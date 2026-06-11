/**
 * Grace window kept after a transient WebSocket disconnect before the PTY is
 * killed. A reconnect with the same sessionId within this window resumes the
 * still-alive PTY instead of spawning a new one. This prevents an API heartbeat
 * false-positive terminate from destroying the user's live shell.
 *
 * The PTY has no idle timeout — it stays alive as long as the WebSocket is
 * connected. Cleanup is handled solely by this grace window on disconnect.
 * MAX_CONCURRENT_SESSIONS caps the number of concurrently open sessions, so
 * the blast radius of a permanently-open WS holding a session is bounded.
 */
export const SESSION_GRACE_TIMEOUT_MS = 300 * 1000 // 5 minutes
export const MAX_CONCURRENT_SESSIONS = 5
export const TERMINAL_DEFAULT_COLS = 80
export const TERMINAL_DEFAULT_ROWS = 24
export const TERMINAL_WS_RECONNECT_BASE_DELAY_MS = 1000
export const TERMINAL_WS_MAX_RECONNECT_RETRIES = Number.POSITIVE_INFINITY
