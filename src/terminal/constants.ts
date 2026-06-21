import { ENV_VARS } from '../constants'

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
 *
 * Default: 3_600_000 ms (60 minutes), so an idle production terminal is not
 * lost while the user steps away. Override per environment with the env var
 * AI_SUPPORT_AGENT_TERMINAL_GRACE_MS (milliseconds; the value must be a pure
 * positive-integer string such as "120000"). Any set-but-invalid value (e.g.
 * "abc", "-1", "0", "60s", "1e6", "1_200_000") emits a warning to stderr and
 * falls back to the 60-minute default.
 *
 * NOTE: This IIFE runs exactly once at process startup (module load). Changing
 * the env var afterwards has no effect; a process restart is required for the
 * new value to take effect.
 *
 * This value is expected to be operated in lockstep with the API-side
 * TERMINAL_SESSION_GRACE_MS so both ends keep the session for the same window.
 */
export const SESSION_GRACE_TIMEOUT_MS = (() => {
  const DEFAULT_MS = 3_600_000 // 60 minutes
  const raw = process.env[ENV_VARS.TERMINAL_GRACE_MS]?.trim()
  // Unset (or set to an empty/whitespace-only string) means "use the default";
  // no warning in that case.
  if (raw === undefined || raw === '') return DEFAULT_MS
  // Accept only pure positive-integer strings. parseInt would silently
  // truncate / accept inputs like "60s" (→ 60) or "1e6" (→ 1), which
  // surprises operators — same rationale as resolveRotateOptions() in
  // src/cli/log-rotate-command.ts.
  if (/^\d+$/.test(raw)) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  // Module-load time: the logger is not safe to import here (circular
  // dependency risk), so write directly to stderr like src/mcp/server.ts.
  process.stderr.write(
    `[terminal] ${ENV_VARS.TERMINAL_GRACE_MS}="${raw}" は無効です（正の整数ミリ秒が必要）。デフォルト ${DEFAULT_MS}ms を使用します\n`,
  )
  return DEFAULT_MS
})()
/**
 * Upper bound (in bytes) of the per-session scrollback ring buffer kept by
 * TerminalSession. PTY output is appended to the buffer alongside the live
 * stdout relay; when the total exceeds this cap the OLDEST bytes are dropped.
 * On a successful resume the buffer is replayed (base64 `replay` message)
 * right after `ready` and before any subsequent live `stdout`, so the web
 * client can restore the screen content lost during the disconnect.
 */
export const SCROLLBACK_BUFFER_MAX_BYTES = 256 * 1024 // 256KB per session
export const TERMINAL_DEFAULT_COLS = 80
export const TERMINAL_DEFAULT_ROWS = 24
export const TERMINAL_WS_RECONNECT_BASE_DELAY_MS = 1000
export const TERMINAL_WS_MAX_RECONNECT_RETRIES = Number.POSITIVE_INFINITY
