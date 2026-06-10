const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  white: '\x1b[97m',
} as const

/** Colors cycled through for per-project prefixes */
const PROJECT_COLOR_CYCLE = [
  COLORS.cyan,
  COLORS.magenta,
  COLORS.brightGreen,
  COLORS.brightYellow,
  COLORS.brightCyan,
  COLORS.brightMagenta,
  COLORS.brightBlue,
  COLORS.white,
] as const

const projectColorMap = new Map<string, string>()
let colorIndex = 0

/**
 * Returns a consistent ANSI color code for the given project key.
 * Each unique key gets the next color in the cycle.
 */
export function getProjectColor(projectKey: string): string {
  let color = projectColorMap.get(projectKey)
  if (!color) {
    color = PROJECT_COLOR_CYCLE[colorIndex % PROJECT_COLOR_CYCLE.length]
    colorIndex++
    projectColorMap.set(projectKey, color)
  }
  return color
}

/** Reset project color assignments (for testing). */
export function resetProjectColors(): void {
  projectColorMap.clear()
  colorIndex = 0
}

/**
 * Prepend each line of `text` with a colored project prefix.
 * Partial last lines (no trailing newline) are also prefixed.
 */
export function prefixLines(text: string, prefix: string): string {
  if (!text) return text
  const lines = text.split('\n')
  // If text ends with \n, the last element is '' — skip prefixing the empty trailing element
  const hasTrailingNewline = text.endsWith('\n')
  const result: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === lines.length - 1 && hasTrailingNewline && line === '') {
      result.push('')
    } else {
      result.push(`${prefix}${line}`)
    }
  }
  return result.join('\n')
}

/**
 * Regex matching ANSI CSI escape sequences that move the cursor or erase
 * screen content — but NOT SGR color/formatting codes (which end in `m`).
 *
 * Covers:
 *   \x1b[<n>A-H  — cursor movement (up/down/forward/back/next-line/prev-line/
 *                   horizontal-absolute/position)
 *   \x1b[<n>J    — erase in display
 *   \x1b[<n>K    — erase in line
 *   \x1b[<n>S/T  — scroll up/down
 *   \x1b[<n>f    — horizontal vertical position
 *   \x1b[s/u     — save/restore cursor position
 *   \x1b[?<n>h/l — DEC private modes (hide/show cursor, bracketed paste, etc.)
 */
const CURSOR_CODE_RE = /\x1b\[[\d;]*[A-HJKSTfsu]|\x1b\[\?[\d;]*[hl]/g

/**
 * Strip ANSI cursor-movement and erase escape sequences from `text`.
 * SGR color/formatting codes (`\x1b[...m`) are intentionally preserved.
 */
export function stripCursorCodes(text: string): string {
  return text.replace(CURSOR_CODE_RE, '')
}

/**
 * Creates a stateful line-buffering writer that ensures each output line
 * is prefixed atomically. Chunks that don't end with a newline are held in
 * a buffer until the next chunk completes the line, preventing interleaved
 * output from concurrent projects from splitting a single line across writes.
 *
 * @param prefix  The colored project prefix string to prepend to each line.
 * @param write   The underlying write function (e.g. process.stdout.write).
 * @returns A function that accepts raw text chunks.
 */
export function makeLinePrefixer(
  prefix: string,
  write: (s: string) => void,
): (chunk: string) => void {
  let lineBuffer = ''
  return (chunk: string): void => {
    // Normalize \r\n → \n, bare \r → \n, then strip cursor-movement codes
    const normalized = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    lineBuffer += stripCursorCodes(normalized)
    const newlineIdx = lineBuffer.lastIndexOf('\n')
    if (newlineIdx === -1) return // no complete line yet — keep buffering
    const complete = lineBuffer.slice(0, newlineIdx + 1)
    lineBuffer = lineBuffer.slice(newlineIdx + 1)
    write(prefixLines(complete, prefix))
  }
}

let verboseEnabled = false

function timestamp(): string {
  const now = new Date()
  const y = now.getFullYear()
  const mo = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const h = String(now.getHours()).padStart(2, '0')
  const mi = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // PEM private key blocks (must be first to avoid partial masking by other patterns)
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[PRIVATE KEY REDACTED]' },
  // AWS Access Key IDs
  { pattern: /(AKIA[A-Z0-9]{16})/g, replacement: 'AKIA****' },
  // GitHub/GitLab personal access tokens (before generic token: pattern)
  { pattern: /\bgh[pos]_[A-Za-z0-9]{36,}\b/g, replacement: 'gh**_****' },
  { pattern: /\bglpat-[A-Za-z0-9_-]{10,}\b/g, replacement: 'glpat-****' },
  // JWT tokens (3-part base64url separated by dots)
  { pattern: /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]+/g, replacement: '$1.****' },
  // Bearer tokens
  { pattern: /(Bearer\s+)[^\s]+/gi, replacement: '$1****' },
  // Database connection strings (postgres://user:pass@host, mysql://user:pass@host, etc.)
  { pattern: /((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^:]+:)[^@]+(@)/gi, replacement: '$1****$2' },
  // Key-value pairs with secret-like keys (last to avoid masking well-formatted tokens above)
  { pattern: /((?:password|secret|token|api_key|apikey|access_key|secret_key|session_token|authorization)\s*[:=]\s*["']?)([^\s"',}{]+)/gi, replacement: '$1****' },
]

/** Mask secrets in log messages */
export function maskSecrets(message: string): string {
  let masked = message
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexps
    pattern.lastIndex = 0
    masked = masked.replace(pattern, replacement)
  }
  return masked
}

/**
 * Structured context fields attached to a log entry (e.g. tenantCode,
 * projectCode, agentId). String values are masked for secrets; non-string
 * values are passed through unchanged.
 */
export type LogContext = Record<string, unknown>

/**
 * Reserved top-level fields of a JSON log entry. Context keys colliding with
 * these are ignored so callers cannot spoof the level/message/timestamp.
 */
const RESERVED_LOG_FIELDS = new Set(['level', 'message', 'timestamp'])

/**
 * Opt-in JSON structured output. Defaults to the human-readable text format.
 * Initialized from the AI_AGENT_LOG_FORMAT env var (`json` enables it) so
 * daemonized/service operation can request JSON without code changes, while
 * interactive use keeps the colored text format.
 */
let jsonModeEnabled = process.env.AI_AGENT_LOG_FORMAT === 'json'

/** Enable or disable JSON structured output at runtime. */
export function setJsonMode(enabled: boolean): void {
  jsonModeEnabled = enabled
}

/** Whether JSON structured output is currently enabled. */
export function isJsonMode(): boolean {
  return jsonModeEnabled
}

/**
 * Context keys whose values are considered sensitive and fully redacted
 * regardless of their content (mirrors the key-value SECRET_PATTERNS keys).
 */
const SECRET_CONTEXT_KEY_RE = /^(?:password|secret|token|api_?key|access_?key|secret_?key|session_?token|authorization)$/i

/**
 * Mask secrets in a context object:
 *  - values under secret-like keys are fully redacted,
 *  - other string values are run through maskSecrets,
 *  - non-string values are passed through unchanged.
 */
function maskContext(context: LogContext): LogContext {
  const masked: LogContext = {}
  for (const [key, value] of Object.entries(context)) {
    if (SECRET_CONTEXT_KEY_RE.test(key) && typeof value === 'string') {
      masked[key] = '****'
    } else {
      masked[key] = typeof value === 'string' ? maskSecrets(value) : value
    }
  }
  return masked
}

/** Render a context object as a readable ` key=value` suffix for text mode. */
function formatTextContext(context: LogContext | undefined): string {
  if (!context) return ''
  const masked = maskContext(context)
  const parts = Object.entries(masked).map(([key, value]) => {
    const str = typeof value === 'string' ? value : JSON.stringify(value)
    return `${key}=${str}`
  })
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

function formatLog(level: string, color: string, message: string, context?: LogContext): string {
  return `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${color}${level}${COLORS.reset} ${maskSecrets(message)}${formatTextContext(context)}`
}

/** Build a JSON log line with reserved fields plus masked context fields. */
function formatJsonLog(level: string, message: string, context?: LogContext): string {
  const entry: Record<string, unknown> = {
    level,
    message: maskSecrets(message),
    timestamp: new Date().toISOString(),
  }
  if (context) {
    for (const [key, value] of Object.entries(maskContext(context))) {
      // Reserved fields cannot be overridden by caller-supplied context.
      if (!RESERVED_LOG_FIELDS.has(key)) {
        entry[key] = value
      }
    }
  }
  return JSON.stringify(entry)
}

export const logger = {
  setVerbose(enabled: boolean): void {
    verboseEnabled = enabled
  },

  info(message: string, context?: LogContext): void {
    console.log(
      jsonModeEnabled
        ? formatJsonLog('info', message, context)
        : formatLog('INFO ', COLORS.green, message, context),
    )
  },

  warn(message: string, context?: LogContext): void {
    console.log(
      jsonModeEnabled
        ? formatJsonLog('warn', message, context)
        : formatLog('WARN ', COLORS.yellow, message, context),
    )
  },

  error(message: string, context?: LogContext): void {
    console.error(
      jsonModeEnabled
        ? formatJsonLog('error', message, context)
        : formatLog('ERROR', COLORS.red, message, context),
    )
  },

  debug(message: string, context?: LogContext): void {
    if (verboseEnabled) {
      console.log(
        jsonModeEnabled
          ? formatJsonLog('debug', message, context)
          : formatLog('DEBUG', COLORS.blue, message, context),
      )
    }
  },

  success(message: string, context?: LogContext): void {
    if (jsonModeEnabled) {
      console.log(formatJsonLog('success', message, context))
    } else {
      console.log(`${COLORS.green}✓${COLORS.reset} ${message}${formatTextContext(context)}`)
    }
  },
}
