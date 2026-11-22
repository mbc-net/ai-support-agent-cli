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
 * Every argv element is finally re-checked against SAFE_ARG (no shell
 * metacharacters, whitespace, quotes or control characters), so joining the
 * argv with single spaces yields a string the remote shell splits back into
 * exactly the same argv — no pipes, redirections or expansions.
 *
 * Keep the rules (and the accept/reject tables in
 * `__tests__/commands/readonly-diagnostic-catalog.spec.ts`) in sync with the
 * api whenever either side changes.
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
] as const

export type ReadonlyDiagnosticId = (typeof READONLY_DIAGNOSTIC_IDS)[number]

/** A validated diagnostic command. */
export interface ReadonlyDiagnostic {
  id: ReadonlyDiagnosticId
  /** Normalized params (defaults filled in). */
  params: Record<string, string | number>
  /** argv made only of SAFE_ARG elements. */
  argv: string[]
}

export interface BuildReadonlyDiagnosticOptions {
  /**
   * Paths `log_tail` may read (resolved by the api from project settings).
   * A path must be in this list AND pass validateReadonlyLogPath.
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

/** Max length of a single log path. */
export const READONLY_LOG_PATH_MAX_LENGTH = 200

/** systemd unit name. Must start alphanumeric so it can never be read as an option. */
const UNIT = /^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,119}\.(service|socket|timer|mount|target)$/

/** Characters allowed in each argv element. */
const SAFE_ARG = /^[A-Za-z0-9@_.:/=,+-]+$/

/** Characters allowed in a log path (wildcards, whitespace, quotes, metachars are rejected). */
const LOG_PATH_CHARS = /^[A-Za-z0-9._/-]+$/

/** Files below this directory may always be read (the directory itself is not a file). */
const LOG_ROOT = '/var/log/'

/** Max number of custom log roots per project. */
export const READONLY_LOG_ROOTS_MAX = 10

/**
 * A custom log root must not equal or be below any of these directories
 * (system configuration, kernel interfaces, binaries, state, temp, secrets).
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
  '/mnt/',
  '/media/',
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

function parseLines(value: unknown): number | null {
  if (value === undefined) return READONLY_DIAGNOSTIC_DEFAULT_LINES
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < 1 || value > READONLY_DIAGNOSTIC_MAX_LINES) return null
  return value
}

function parseUnit(value: unknown): string | null {
  return typeof value === 'string' && UNIT.test(value) ? value : null
}

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
  log_tail: {
    keys: ['path', 'lines'],
    build: (p, options) => {
      const lines = parseLines(p.lines)
      if (lines === null) return null
      const path = validateReadonlyLogPath(p.path, options.allowedLogRoots)
      if (path === null || !options.allowedLogPaths.includes(path)) return null
      return { params: { path, lines }, argv: ['tail', '-n', String(lines), '--', path] }
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
  if (!built.argv.every((a) => SAFE_ARG.test(a))) return null

  return { id, params: built.params, argv: built.argv }
}

/** The command text for an argv (same rule as the api's `expectedCommand`). */
export function readonlyDiagnosticCommandText(argv: readonly string[]): string {
  return argv.join(' ')
}

/** Keep only the first `maxLines` lines. */
export function firstLines(text: string, maxLines: number): string {
  return text.split('\n').slice(0, maxLines).join('\n')
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
