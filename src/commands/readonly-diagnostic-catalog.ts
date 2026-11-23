/**
 * Catalog of read-only diagnostic commands the alarm AI check may run on a
 * target server (`readonly_diagnostic` command, see `commands/index.ts`).
 *
 * This is an independent reimplementation of the api's
 * `src/alarm-ai-check/readonly-diagnostic-catalog.ts` and
 * `readonly-log-path.util.ts` (defense in depth): the agent never executes a
 * command string taken from the payload. It rebuilds the argv itself from
 * `catalogId` / `params` / `allowedLogPaths`, and only runs it when the result
 * matches the api-issued `expectedCommand` exactly. Even a compromised api
 * therefore cannot make the agent run anything outside this catalog.
 *
 * Every argv element is finally re-checked with quoteArg: plain SAFE_ARG
 * elements stay as they are, elements with `*`, `?`, spaces or `#%()` are
 * single-quoted, anything else (quotes, backslash, `$`, backtick, `;`, `|`,
 * `&`, `<`, `>`, control characters) is rejected. Joining the quoted argv with
 * single spaces therefore yields a string the remote login shell splits back
 * into exactly the same argv — no pipes, redirections, globbing or expansions.
 *
 * Keep the rules (and the accept/reject tables in
 * `__tests__/commands/readonly-diagnostic-catalog.spec.ts` and
 * `readonly-log-patterns.spec.ts`) in sync with the api whenever either side
 * changes.
 */

/** Capability advertised at registration so the api dispatches these commands to this agent. */
export const READONLY_DIAGNOSTIC_CAPABILITY = 'readonly_diagnostic_v1'

export const READONLY_DIAGNOSTIC_IDS = [
  'uptime',
  'disk_usage',
  'memory',
  'failed_units',
  'unit_status',
  'unit_journal',
  'top_processes',
  'listening_ports',
  'log_tail',
  'log_list',
  'log_grep',
] as const

export type ReadonlyDiagnosticId = (typeof READONLY_DIAGNOSTIC_IDS)[number]

/** A validated diagnostic command. */
export interface ReadonlyDiagnostic {
  id: ReadonlyDiagnosticId
  /** Normalized params (defaults filled in). */
  params: Record<string, string | number>
  /** argv whose every element passes quoteArg. */
  argv: string[]
}

export interface BuildReadonlyDiagnosticOptions {
  /**
   * Log path patterns (resolved by the api from project settings). A concrete
   * file `log_tail` / `log_grep` may read must satisfy isAllowedLogFile against
   * these; `log_list` takes exactly one of them. Patterns that fail
   * validateReadonlyLogPattern are ignored.
   */
  allowedLogPaths: readonly string[]
  /**
   * Extra directories (besides /var/log/) whose files `log_tail` may read,
   * resolved by the api from project settings. Roots that fail
   * validateReadonlyLogRoot are ignored. Unset = no extra roots.
   */
  allowedLogRoots?: readonly string[]
}

/** Lines kept from `top_processes` (1 header + top 20). `ps` cannot limit rows itself. */
export const TOP_PROCESSES_OUTPUT_LINES = 21

/** Hard upper bound on the output bytes returned to the api. */
export const READONLY_DIAGNOSTIC_MAX_OUTPUT_BYTES = 16384

export const READONLY_DIAGNOSTIC_DEFAULT_LINES = 100
export const READONLY_DIAGNOSTIC_MAX_LINES = 200

/** Max length of a single log path (or path pattern). */
export const READONLY_LOG_PATH_MAX_LENGTH = 200

/** Max length of a `log_grep` search text. */
export const READONLY_LOG_GREP_TEXT_MAX_LENGTH = 100

/** `log_list` output is cut to this many lines (after filtering secret names). */
export const READONLY_LOG_LIST_MAX_LINES = 200

/** `.gz` tail and `log_grep` stop reading after this many bytes of (decompressed) output. */
export const READONLY_LOG_STREAM_MAX_BYTES = 256 * 1024 * 1024

/** systemd unit name. Must start alphanumeric so it can never be read as an option. */
const UNIT = /^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,119}\.(service|socket|timer|mount|target)$/

/** argv elements passed to the remote shell as they are. */
const SAFE_ARG = /^[A-Za-z0-9@_.:/=,+-]+$/

/** argv elements passed single-quoted (no quote, backslash, `$`, backtick, `;|&<>`, control chars). */
const QUOTABLE_ARG = /^[A-Za-z0-9@_.:/=,+*? #%()-]+$/

/** Characters allowed in a log path (wildcards, whitespace, quotes, metachars are rejected). */
const LOG_PATH_CHARS = /^[A-Za-z0-9._/-]+$/

/** Characters allowed in a log path pattern (`*` / `?` only in the last segment). */
const LOG_PATTERN_CHARS = /^[A-Za-z0-9._/*?-]+$/

/** Characters allowed in a `log_grep` search text (a fixed string). */
const GREP_TEXT_CHARS = /^[A-Za-z0-9@_.:/=,+ #%()-]+$/

/** Files below this directory may always be read (the directory itself is not a file). */
const LOG_ROOT = '/var/log/'

/** Max number of custom log roots per project. */
export const READONLY_LOG_ROOTS_MAX = 10

/**
 * A custom log root must not equal or be below any of these directories
 * (system configuration, kernel interfaces, binaries, state, temp, secrets).
 * `/mnt/` and `/media/` are allowed (data disks such as `/mnt/disk1/app/logs/`).
 */
const DENIED_LOG_ROOT_PREFIXES = [
  '/etc/',
  '/root/',
  '/proc/',
  '/sys/',
  '/dev/',
  '/run/',
  '/boot/',
  '/usr/',
  '/bin/',
  '/sbin/',
  '/lib/',
  '/lib32/',
  '/lib64/',
  '/libx32/',
  '/var/lib/',
  '/var/run/',
  '/var/spool/',
  '/tmp/',
  '/var/tmp/',
  '/snap/',
  '/srv/secrets/',
  '/var/backups/',
  '/var/mail/',
  '/var/cache/',
] as const

/** Path segments (directory or file names) that are never read, compared case-insensitively. */
const SENSITIVE_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  'credentials',
  '.aws',
  '.kube',
  '.docker',
  '.gnupg',
  '.ssh',
  '.netrc',
  '.npmrc',
  '.pgpass',
  '.git-credentials',
  '.my.cnf',
  'authorized_keys',
  'known_hosts',
  '.htpasswd',
  '.vault-token',
  '.boto',
  '.s3cfg',
])
const SENSITIVE_SEGMENT_PREFIXES = ['.env', 'id_', 'credentials.', 'shadow', 'gshadow', 'passwd'] as const
const SENSITIVE_SEGMENT_SUFFIXES = ['_key', '.key', '.pem', '.p12', '.pfx', '.env', 'history', '.kdbx'] as const

function isSensitiveSegment(segment: string): boolean {
  const lower = segment.toLowerCase()
  return (
    SENSITIVE_SEGMENT_NAMES.has(lower) ||
    SENSITIVE_SEGMENT_PREFIXES.some((prefix) => lower.startsWith(prefix)) ||
    SENSITIVE_SEGMENT_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  )
}

type Params = Record<string, unknown>
type Built = { params: Record<string, string | number>; argv: string[] } | null

interface CatalogEntry {
  /** Accepted param names. Any other key rejects the request. */
  keys: readonly string[]
  build: (p: Params, options: BuildReadonlyDiagnosticOptions) => Built
}

/**
 * Validate a custom log root (a directory). Returns the root when accepted,
 * otherwise null.
 *
 * Rules: absolute, ends with `/`, at most 200 chars of `[A-Za-z0-9._/-]`;
 * rejects `..`, `//` and `.` segments; at least 2 segments (`/opt/` and `/`
 * are rejected); must not equal or be below any DENIED_LOG_ROOT_PREFIXES
 * entry; `/var/log/` itself is rejected as redundant; every segment must pass
 * the same secret-name rules as log paths (case-insensitive).
 */
export function validateReadonlyLogRoot(root: unknown): string | null {
  if (typeof root !== 'string') return null
  if (root.length > READONLY_LOG_PATH_MAX_LENGTH) return null
  if (!LOG_PATH_CHARS.test(root)) return null
  if (!root.startsWith('/') || !root.endsWith('/')) return null
  if (root.includes('..') || root.includes('//')) return null

  const segments = root.slice(1, -1).split('/')
  if (segments.length < 2) return null
  if (segments.some((s) => s === '' || s === '.' || isSensitiveSegment(s))) return null

  if (root === LOG_ROOT) return null
  if (DENIED_LOG_ROOT_PREFIXES.some((prefix) => root.startsWith(prefix))) return null

  return root
}

/**
 * Validate a log path. Returns the path when accepted, otherwise null.
 *
 * Rules: at most 200 chars of `[A-Za-z0-9._/-]`, strictly below `/var/log/`
 * or strictly below one of `roots` (the directory itself is not a file; no
 * trailing `/`); roots that fail validateReadonlyLogRoot are ignored; rejects
 * `..`, `//` and `.` segments; rejects any segment named `.env*`, `id_*`,
 * `*_key`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `*.env`, `credentials`,
 * `credentials.*`, `*history`, `.aws`, `.kube`, `.docker`, `.gnupg`, `.ssh`,
 * `.netrc`, `.npmrc`, `.pgpass`, `.git-credentials`, `.my.cnf`,
 * `authorized_keys`, `known_hosts`, `.htpasswd`, `.vault-token`, `.boto`,
 * `.s3cfg`, `shadow*`, `gshadow*`, `passwd*` or `*.kdbx` (case-insensitive).
 *
 * This only checks the string. Symlinks are checked on the target host right
 * before reading (see buildLogTailPreflight).
 */
export function validateReadonlyLogPath(path: unknown, roots: readonly string[] = []): string | null {
  if (typeof path !== 'string') return null
  if (path.length > READONLY_LOG_PATH_MAX_LENGTH) return null
  if (!LOG_PATH_CHARS.test(path)) return null
  if (path.endsWith('/')) return null
  if (path.includes('..') || path.includes('//')) return null

  const underRoot = (root: string) => path.startsWith(root) && path.length > root.length
  const allowedRoots = [LOG_ROOT, ...roots.filter((root) => validateReadonlyLogRoot(root) !== null)]
  if (!allowedRoots.some(underRoot)) return null

  const segments = path.slice(1).split('/')
  if (segments.some((s) => s === '.' || isSensitiveSegment(s))) return null

  return path
}

/** Split a path (pattern) into its directory (with trailing `/`) and last segment. */
export function splitReadonlyLogPattern(pattern: string): { dir: string; name: string } {
  const slash = pattern.lastIndexOf('/')
  return { dir: pattern.slice(0, slash + 1), name: pattern.slice(slash + 1) }
}

/**
 * Validate a log path pattern (a `readonlyLogPaths` entry). Returns the
 * pattern when accepted, otherwise null.
 *
 * Rules: at most 200 chars of `[A-Za-z0-9._/*?-]`; `*` / `?` only in the last
 * segment and never `**`; the pattern with every `*` / `?` removed from its
 * last segment must not be a secret-looking name; everything else follows
 * validateReadonlyLogPath (absolute, no `..` / `.` / `//` / trailing `/`,
 * strictly below `/var/log/` or a valid root, secret names on every directory
 * segment). A pattern without wildcards is just validateReadonlyLogPath.
 */
export function validateReadonlyLogPattern(pattern: unknown, roots: readonly string[] = []): string | null {
  if (typeof pattern !== 'string') return null
  if (pattern.length > READONLY_LOG_PATH_MAX_LENGTH) return null
  if (!LOG_PATTERN_CHARS.test(pattern)) return null
  if (!/[*?]/.test(pattern)) return validateReadonlyLogPath(pattern, roots)
  if (pattern.includes('**')) return null

  const { dir, name } = splitReadonlyLogPattern(pattern)
  if (/[*?]/.test(dir) || name === '') return null
  if (isSensitiveSegment(name.replace(/[*?]/g, ''))) return null
  // Validate the directory part and the literal rules (`..`, `//`, roots)
  // with a neutral file name standing in for the wildcard segment.
  if (pattern.includes('..') || pattern.includes('//')) return null
  if (validateReadonlyLogPath(`${dir}x`, roots) === null) return null
  return pattern
}

/**
 * Full-match a file name against a glob (`*` = any run of characters, `?` =
 * exactly one character, case-sensitive). Linear-time greedy matcher (no
 * regex backtracking).
 */
export function globMatch(glob: string, name: string): boolean {
  let g = 0
  let n = 0
  let starG = -1
  let starN = 0
  while (n < name.length) {
    if (g < glob.length && (glob[g] === '?' || glob[g] === name[n])) {
      g++
      n++
    } else if (g < glob.length && glob[g] === '*') {
      starG = g++
      starN = n
    } else if (starG >= 0) {
      g = starG + 1
      n = ++starN
    } else {
      return false
    }
  }
  while (g < glob.length && glob[g] === '*') g++
  return g === glob.length
}

/**
 * Whether a concrete file may be read: it passes validateReadonlyLogPath
 * (with `roots`) and some valid pattern has the same directory and a last
 * segment that glob-matches the file name. Rotated names are just names:
 * `app.log*` matches `app.log`, `app.log.1` and `app.log.12.gz`.
 */
export function isAllowedLogFile(path: unknown, patterns: readonly string[], roots: readonly string[] = []): boolean {
  if (typeof path !== 'string' || /[*?]/.test(path)) return false
  if (validateReadonlyLogPath(path, roots) === null) return false
  const file = splitReadonlyLogPattern(path)
  return patterns.some((pattern) => {
    if (validateReadonlyLogPattern(pattern, roots) === null) return false
    const { dir, name } = splitReadonlyLogPattern(pattern)
    return dir === file.dir && globMatch(name, file.name)
  })
}

/**
 * Quote one argv element for the remote login shell: SAFE_ARG elements as they
 * are, QUOTABLE_ARG elements single-quoted, anything else rejected (null).
 */
export function quoteArg(arg: string): string | null {
  if (SAFE_ARG.test(arg)) return arg
  if (QUOTABLE_ARG.test(arg)) return `'${arg}'`
  return null
}

/** Remote checks run (with the same credential) before `log_tail` reads a file. */
export interface LogTailPreflight {
  /**
   * Prints the fully resolved path; it must equal the requested path plus a
   * newline, i.e. no component of the path is a symlink and the file exists.
   */
  resolve: string[]
  /** Exits 0 with no output only for a regular file. */
  regularFile: string[]
}

/**
 * Build the symlink / regular-file checks for a log path. The api cannot see
 * the target filesystem, so this is enforced only on the agent side.
 * Returns null when the path fails validateReadonlyLogPath (with `roots`) or SAFE_ARG.
 */
export function buildLogTailPreflight(path: string, roots: readonly string[] = []): LogTailPreflight | null {
  if (validateReadonlyLogPath(path, roots) === null) return null
  const preflight: LogTailPreflight = {
    resolve: ['readlink', '-e', '--', path],
    // `test` takes no `--`; the path always starts with `/`, so it cannot be read as an operator.
    regularFile: ['test', '-f', path],
  }
  const safe = [...preflight.resolve, ...preflight.regularFile].every((a) => SAFE_ARG.test(a))
  return safe ? preflight : null
}

/** Remote check run before `log_list` lists a directory. */
export interface LogDirPreflight {
  /** The directory `find` lists (no trailing `/`). */
  dir: string
  /** Prints the fully resolved directory; it must equal `dir` plus a newline (no symlink). */
  resolve: string[]
}

/** Directory (without trailing `/`) `log_list` lists for a pattern. */
function logListDirectory(pattern: string): string {
  return splitReadonlyLogPattern(pattern).dir.slice(0, -1)
}

/**
 * Build the symlink check for the directory of a `log_list` pattern.
 * Returns null when the pattern fails validateReadonlyLogPattern (with `roots`).
 */
export function buildLogDirPreflight(pattern: string, roots: readonly string[] = []): LogDirPreflight | null {
  if (validateReadonlyLogPattern(pattern, roots) === null) return null
  const dir = logListDirectory(pattern)
  if (!SAFE_ARG.test(dir)) return null
  return { dir, resolve: ['readlink', '-e', '--', dir] }
}

function parseLines(value: unknown): number | null {
  if (value === undefined) return READONLY_DIAGNOSTIC_DEFAULT_LINES
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < 1 || value > READONLY_DIAGNOSTIC_MAX_LINES) return null
  return value
}

function parseUnit(value: unknown): string | null {
  return typeof value === 'string' && UNIT.test(value) ? value : null
}

function parseLogFile(value: unknown, options: BuildReadonlyDiagnosticOptions): string | null {
  return typeof value === 'string' && isAllowedLogFile(value, options.allowedLogPaths, options.allowedLogRoots)
    ? value
    : null
}

function parseGrepText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length < 1 || value.length > READONLY_LOG_GREP_TEXT_MAX_LENGTH) return null
  return GREP_TEXT_CHARS.test(value) ? value : null
}

const isGzip = (path: string): boolean => path.endsWith('.gz')

/**
 * Remote resource cap for commands that may scan large inputs (`log_grep`,
 * `.gz` `log_tail`): at most 60 s, lowest CPU and idle I/O priority. Exit
 * code 124 means the remote timeout fired.
 */
export const READONLY_REMOTE_RESOURCE_CAP = ['timeout', '60', 'nice', '-n', '19', 'ionice', '-c', '3'] as const

/** Exit code of `timeout` when it stopped the command. */
export const READONLY_REMOTE_TIMEOUT_EXIT_CODE = 124

const fixed = (argv: readonly string[]): CatalogEntry => ({
  keys: [],
  build: () => ({ params: {}, argv: [...argv] }),
})

const CATALOG: Readonly<Record<ReadonlyDiagnosticId, CatalogEntry>> = {
  uptime: fixed(['uptime']),
  disk_usage: fixed(['df', '-h']),
  memory: fixed(['free', '-m']),
  failed_units: fixed(['systemctl', '--failed', '--no-pager', '--no-legend']),
  unit_status: {
    keys: ['unit'],
    build: (p) => {
      const unit = parseUnit(p.unit)
      if (!unit) return null
      return { params: { unit }, argv: ['systemctl', 'status', '--no-pager', '--lines=50', unit] }
    },
  },
  unit_journal: {
    keys: ['unit', 'lines'],
    build: (p) => {
      const unit = parseUnit(p.unit)
      const lines = parseLines(p.lines)
      if (!unit || lines === null) return null
      return { params: { unit, lines }, argv: ['journalctl', '-u', unit, '-n', String(lines), '--no-pager'] }
    },
  },
  // No `| head`: the output is cut to TOP_PROCESSES_OUTPUT_LINES by the executor.
  top_processes: fixed(['ps', '-eo', 'pid,user,pcpu,pmem,etime,comm', '--sort=-pcpu']),
  listening_ports: fixed(['ss', '-tln']),
  // `.gz`: decompress and keep the last `lines` lines on the agent (ring buffer).
  log_tail: {
    keys: ['path', 'lines'],
    build: (p, options) => {
      const lines = parseLines(p.lines)
      const path = parseLogFile(p.path, options)
      if (lines === null || path === null) return null
      const argv = isGzip(path)
        ? [...READONLY_REMOTE_RESOURCE_CAP, 'gzip', '-dc', '--', path]
        : ['tail', '-n', String(lines), '--', path]
      return { params: { path, lines }, argv }
    },
  },
  // `pattern` must be exactly one of the allowed patterns.
  log_list: {
    keys: ['pattern'],
    build: (p, options) => {
      const pattern = p.pattern
      if (typeof pattern !== 'string' || !options.allowedLogPaths.includes(pattern)) return null
      if (validateReadonlyLogPattern(pattern, options.allowedLogRoots) === null) return null
      const { name } = splitReadonlyLogPattern(pattern)
      return {
        params: { pattern },
        argv: ['find', logListDirectory(pattern), '-maxdepth', '1', '-type', 'f', '-name', name, '-ls'],
      }
    },
  },
  // Fixed-string search; the agent keeps the last `lines` matches (ring buffer).
  log_grep: {
    keys: ['path', 'text', 'lines'],
    build: (p, options) => {
      const lines = parseLines(p.lines)
      const path = parseLogFile(p.path, options)
      const text = parseGrepText(p.text)
      if (lines === null || path === null || text === null) return null
      return {
        params: { path, text, lines },
        argv: [...READONLY_REMOTE_RESOURCE_CAP, isGzip(path) ? 'zgrep' : 'grep', '-F', '-n', '-e', text, '--', path],
      }
    },
  },
}

export function isReadonlyDiagnosticId(id: unknown): id is ReadonlyDiagnosticId {
  return typeof id === 'string' && (READONLY_DIAGNOSTIC_IDS as readonly string[]).includes(id)
}

function isPlainParams(value: unknown): value is Params {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * Validate a catalog id and params and build the argv to run.
 * Returns null for an unknown id, wrong types, out-of-range or extra params,
 * a log path that is not allowed, or any unsafe character.
 */
export function buildReadonlyDiagnostic(
  id: unknown,
  params: unknown,
  options: BuildReadonlyDiagnosticOptions,
): ReadonlyDiagnostic | null {
  if (!isReadonlyDiagnosticId(id)) return null
  if (params !== undefined && !isPlainParams(params)) return null
  const p: Params = params ?? {}

  const entry = CATALOG[id]
  if (Object.keys(p).some((k) => !entry.keys.includes(k))) return null

  const built = entry.build(p, options)
  if (!built) return null
  if (!built.argv.every((a) => quoteArg(a) !== null)) return null

  return { id, params: built.params, argv: built.argv }
}

/**
 * The command text for an argv (same rule as the api's `expectedCommand`):
 * every element through quoteArg, joined with single spaces. Null when an
 * element cannot be quoted safely.
 */
export function readonlyDiagnosticCommandText(argv: readonly string[]): string | null {
  const quoted = argv.map(quoteArg)
  return quoted.every((a): a is string => a !== null) ? quoted.join(' ') : null
}

/** Keep only the first `maxLines` lines. */
export function firstLines(text: string, maxLines: number): string {
  return text.split('\n').slice(0, maxLines).join('\n')
}

/**
 * Shape `find -ls` output for the api: drop every line whose file name (the
 * text after the last `/`, also cut at the first quote, colon or whitespace
 * so error messages are covered) looks secret, then keep the first
 * READONLY_LOG_LIST_MAX_LINES lines.
 */
export function filterLogListOutput(text: string): string {
  const kept = text.split('\n').filter((line) => {
    const slash = line.lastIndexOf('/')
    if (slash < 0) return true
    const name = line.slice(slash + 1)
    const bare = name.split(/['":\s]/)[0]
    return !isSensitiveSegment(name) && !isSensitiveSegment(bare)
  })
  return kept.slice(0, READONLY_LOG_LIST_MAX_LINES).join('\n')
}

/** Ring buffer keeping the last `max` lines pushed. */
export class LastLines {
  private readonly buffer: string[] = []
  private next = 0

  constructor(private readonly max: number) {}

  push(line: string): void {
    if (this.buffer.length < this.max) {
      this.buffer.push(line)
    } else {
      this.buffer[this.next] = line
      this.next = (this.next + 1) % this.max
    }
  }

  /** The kept lines in order, each followed by `\n` (empty string when none). */
  text(): string {
    const ordered = [...this.buffer.slice(this.next), ...this.buffer.slice(0, this.next)]
    return ordered.map((line) => `${line}\n`).join('')
  }
}

/** Fit `text` into `maxBytes` of UTF-8 without splitting a multibyte character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= maxBytes) return { text, truncated: false }
  let end = maxBytes
  // A continuation byte (10xxxxxx) at the cut point means we are mid-character:
  // step back to the start of that character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true }
}
