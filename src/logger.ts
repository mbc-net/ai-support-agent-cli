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
  // AWS Access Key IDs
  { pattern: /(AKIA[A-Z0-9]{16})/g, replacement: 'AKIA****' },
  // Key-value pairs with secret-like keys
  { pattern: /((?:password|secret|token|api_key|apikey|access_key|secret_key|session_token|authorization)\s*[:=]\s*["']?)([^\s"',}{]+)/gi, replacement: '$1****' },
  // Bearer tokens
  { pattern: /(Bearer\s+)[^\s]+/gi, replacement: '$1****' },
  // Database connection strings (postgres://user:pass@host, mysql://user:pass@host, etc.)
  { pattern: /((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^:]+:)[^@]+(@)/gi, replacement: '$1****$2' },
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

function formatLog(level: string, color: string, message: string): string {
  return `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${color}${level}${COLORS.reset} ${maskSecrets(message)}`
}

export const logger = {
  setVerbose(enabled: boolean): void {
    verboseEnabled = enabled
  },

  info(message: string): void {
    console.log(formatLog('INFO ', COLORS.green, message))
  },

  warn(message: string): void {
    console.log(formatLog('WARN ', COLORS.yellow, message))
  },

  error(message: string): void {
    console.error(formatLog('ERROR', COLORS.red, message))
  },

  debug(message: string): void {
    if (verboseEnabled) {
      console.log(formatLog('DEBUG', COLORS.blue, message))
    }
  },

  success(message: string): void {
    console.log(`${COLORS.green}✓${COLORS.reset} ${message}`)
  },
}
