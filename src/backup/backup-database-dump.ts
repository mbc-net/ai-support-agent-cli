import { execFile, spawn } from 'child_process'
import { X509Certificate } from 'crypto'
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export interface BackupDatabaseConnection {
  engine: 'postgres' | 'mysql'
  host: string
  port: number
  database: string
  username: string
  password: string
  caPem: string
  /** innodb-no-ddl requires the tenant to exclude DDL for the entire operation. */
  mysqlConsistency?: 'innodb-no-ddl' | 'global-read-lock'
}
export interface DatabaseDumpOptions {
  maxBytes: number
  timeoutMs: number
  signal?: AbortSignal
}
const SAFE_ERRORS = new Set(['BACKUP_EXPORT_ABORTED', 'BACKUP_EXPORT_TIMEOUT', 'BACKUP_EXPORT_SIZE_LIMIT', 'BACKUP_MYSQL_NON_TRANSACTIONAL_TABLES', 'BACKUP_MYSQL_PREFLIGHT_FAILED'])

function validate(connection: BackupDatabaseConnection, options: DatabaseDumpOptions): void {
  const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
  try {
    if (!['postgres', 'mysql'].includes(connection.engine) || !text(connection.host, 253) || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(connection.host) ||
      !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 ||
      !text(connection.database, 128) || /[=*]|:\/\//.test(connection.database) ||
      !text(connection.username, 128) || connection.username.includes('*') || !text(connection.password, 8192) ||
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 2 ** 36 - 32 ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 21600000 ||
      typeof connection.caPem !== 'string' || connection.caPem.length > 262144 ||
      (connection.engine === 'mysql' && !['innodb-no-ddl', 'global-read-lock'].includes(connection.mysqlConsistency ?? '')) ||
      (connection.engine === 'postgres' && connection.mysqlConsistency !== undefined)) throw new Error()
    const certs = connection.caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? []
    if (!certs.length || certs.length > 100 || connection.caPem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) throw new Error()
    for (const cert of certs) if (!new X509Certificate(cert).ca) throw new Error()
  } catch {
    throw new Error('BACKUP_DUMP_INVALID_CONFIGURATION')
  }
}

/** A stream ends successfully only after the dump process exits with status zero. */
export async function* streamDatabaseDump(
  input: BackupDatabaseConnection,
  options: DatabaseDumpOptions,
): AsyncGenerator<Buffer> {
  const connection = { ...input }
  const { maxBytes, timeoutMs, signal } = options
  validate(connection, options)
  const deadline = Date.now() + timeoutMs
  if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
  const directory = await mkdtemp(join(tmpdir(), 'ais-backup-dump-'))
  let child: ReturnType<typeof spawn> | undefined
  let exited: Promise<number | null> | undefined
  let closed = false
  let failure: string | undefined
  let timeout: NodeJS.Timeout | undefined
  let killTimer: NodeJS.Timeout | undefined
  const stop = (): void => {
    if (closed || !child) return
    child.kill('SIGTERM')
    if (!killTimer) killTimer = setTimeout(() => { if (!closed) child?.kill('SIGKILL') }, 1000)
  }
  const abort = (): void => {
    failure = 'BACKUP_EXPORT_ABORTED'
    stop()
    child?.stdout?.destroy(new Error(failure))
  }
  try {
    await chmod(directory, 0o700)
    const caFile = join(directory, 'ca.pem')
    const secretFile = join(directory, 'credentials')
    await writeFile(caFile, connection.caPem, { mode: 0o600, flag: 'wx' })
    // Do not inherit PG*, MYSQL*, loader variables or cloud credentials. Explicit
    // flags and files are the only database configuration passed to the child.
    const env: NodeJS.ProcessEnv = {}
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'LANG', 'LC_ALL']) {
      if (process.env[key]) env[key] = process.env[key]
    }
    let binary: string
    let args: string[]
    if (connection.engine === 'postgres') {
      const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
      await writeFile(secretFile, [connection.host, String(connection.port), connection.database, connection.username, connection.password].map(escape).join(':') + '\n', { mode: 0o600, flag: 'wx' })
      Object.assign(env, { PGPASSFILE: secretFile, PGSSLMODE: 'verify-full', PGGSSENCMODE: 'disable', PGSSLROOTCERT: caFile, PGCONNECT_TIMEOUT: '15' })
      binary = 'pg_dump'
      args = ['--format=custom', '--no-password', `--host=${connection.host}`, `--port=${connection.port}`, `--username=${connection.username}`, `--dbname=${connection.database}`]
    } else {
      const password = connection.password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      await writeFile(secretFile, `[client]\npassword="${password}"\n`, { mode: 0o600, flag: 'wx' })
      binary = 'mysqldump'
      const clientArgs = [`--defaults-file=${secretFile}`, '--no-login-paths', '--protocol=TCP', `--host=${connection.host}`, `--port=${connection.port}`, `--user=${connection.username}`, '--ssl-mode=VERIFY_IDENTITY', `--ssl-ca=${caFile}`]
      if (connection.mysqlConsistency === 'innodb-no-ddl') {
        if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
        if (Date.now() >= deadline) throw new Error('BACKUP_EXPORT_TIMEOUT')
        // DDL exclusion is an explicit tenant prerequisite for this mode. The
        // runtime check rejects nontransactional/unknown engines; it cannot
        // enforce other connections' DDL privileges across two connections.
        const query = "SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND (ENGINE IS NULL OR ENGINE <> 'InnoDB')"
        const result = await new Promise<string>((resolve, reject) => {
          child = execFile('mysql', [...clientArgs, `--database=${connection.database}`, '--batch', '--skip-column-names', `--execute=${query}`], {
            env, cwd: directory, shell: false, encoding: 'utf8', maxBuffer: 1024,
            timeout: Math.min(30000, Math.max(1, deadline - Date.now())), killSignal: 'SIGKILL', signal,
          }, (error, stdout) => {
            if (signal?.aborted) reject(new Error('BACKUP_EXPORT_ABORTED'))
            else if (Date.now() >= deadline) reject(new Error('BACKUP_EXPORT_TIMEOUT'))
            else if (error) reject(new Error('BACKUP_MYSQL_PREFLIGHT_FAILED'))
            else resolve(stdout.trim())
          })
          exited = new Promise((resolveExit) => { child!.once('close', (code: number | null) => { closed = true; resolveExit(code) }) })
        })
        if (await exited !== 0) throw new Error('BACKUP_MYSQL_PREFLIGHT_FAILED')
        if (!/^\d+$/.test(result)) throw new Error('BACKUP_MYSQL_PREFLIGHT_FAILED')
        if (result !== '0') throw new Error('BACKUP_MYSQL_NON_TRANSACTIONAL_TABLES')
      }
      args = [...clientArgs, connection.mysqlConsistency === 'global-read-lock' ? '--lock-all-tables' : '--single-transaction', '--quick', '--routines', '--events', '--triggers', '--hex-blob', '--set-gtid-purged=OFF', '--no-tablespaces', '--databases', '--', connection.database]
    }
    if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
    if (Date.now() >= deadline) throw new Error('BACKUP_EXPORT_TIMEOUT')
    closed = false
    child = spawn(binary, args, { env, cwd: directory, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = child.stdout!
    stdout.on('error', () => { /* handled by async iteration, including pre-iteration cancellation */ })
    child.stderr?.resume() // never retain or log tool errors, which can contain connection secrets
    exited = new Promise((resolve) => {
      child!.once('error', () => { failure = failure ?? 'BACKUP_DUMP_FAILED'; stdout.destroy(new Error(failure)) })
      child!.once('close', (code: number | null) => { closed = true; resolve(code) })
    })
    timeout = setTimeout(() => {
      failure = 'BACKUP_EXPORT_TIMEOUT'
      stop()
      stdout.destroy(new Error(failure))
    }, Math.max(1, deadline - Date.now()))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let size = 0
    for await (const chunk of stdout) {
      if (failure) throw new Error(failure)
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.length
      if (size > maxBytes) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
      yield bytes
    }
    const code = await exited
    if (failure) throw new Error(failure)
    if (code !== 0 || !size) throw new Error('BACKUP_DUMP_FAILED')
  } catch (error) {
    const code = failure ?? (error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'BACKUP_DUMP_FAILED')
    throw new Error(code)
  } finally {
    if (timeout) clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
    let cleanupFailed = false
    if (child && !closed && exited) {
      stop()
      let limit: NodeJS.Timeout | undefined
      const finished = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => { limit = setTimeout(() => resolve(false), 5000) }),
      ])
      if (limit) clearTimeout(limit)
      cleanupFailed = !finished
    }
    if (killTimer) clearTimeout(killTimer)
    try {
      await rm(directory, { recursive: true, force: true })
    } catch {
      cleanupFailed = true
    }
    if (cleanupFailed) throw new Error('BACKUP_DUMP_CLEANUP_FAILED')
  }
}
