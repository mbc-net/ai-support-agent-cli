import { execFile, spawn } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, readFileSync, statSync } from 'fs'
import * as fsPromises from 'fs/promises'
import { dirname } from 'path'
import { PassThrough } from 'stream'
import { TEST_CA_PEM } from '../fixtures/rdp-trusted-ca-pems'
import { streamDatabaseDump } from '../../src/backup/backup-database-dump'

jest.mock('child_process', () => ({ spawn: jest.fn(), execFile: jest.fn() }))
jest.mock('fs/promises', () => ({ ...jest.requireActual('fs/promises'), rm: jest.fn() }))
const connection = () => ({ engine: 'postgres' as const, host: 'db.example.com', port: 5432, database: 'app', username: 'backup', password: 'p:a\\ss"word', caPem: TEST_CA_PEM })
const options = { maxBytes: 10000, timeoutMs: 10000 }
async function collect(source: AsyncIterable<Buffer>) { const chunks: Buffer[] = []; for await (const chunk of source) chunks.push(chunk); return Buffer.concat(chunks) }
function child() {
  const value = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 123, kill: jest.fn() })
  value.kill.mockImplementation(() => { setImmediate(() => { value.stdout.end(); value.emit('close', null, 'SIGTERM') }); return true })
  return value
}
function preflight(args: any[], stdout = '0\n') {
  const process = child()
  setImmediate(() => { args[args.length - 1](null, stdout, ''); process.emit('close', 0, null) })
  return process as never
}

describe('database dump streaming', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    jest.mocked(fsPromises.rm).mockImplementation(jest.requireActual('fs/promises').rm)
    jest.mocked(execFile).mockImplementation((...args: any[]) => preflight(args))
  })
  afterEach(() => jest.restoreAllMocks())
  it('reports cleanup failure without exposing filesystem error details', async () => {
    let file = ''
    const remove = jest.requireActual('fs/promises').rm
    jest.mocked(fsPromises.rm).mockRejectedValueOnce(new Error('sensitive credential path'))
    jest.mocked(spawn).mockImplementation((_binary, _args, opts: any) => {
      file = opts.env.PGPASSFILE
      const process = child(); setImmediate(() => { process.stdout.end('dump'); process.emit('close', 0, null) }); return process as never
    })
    try {
      await expect(collect(streamDatabaseDump(connection(), options))).rejects.toThrow(/^BACKUP_DUMP_CLEANUP_FAILED$/)
    } finally {
      if (file) await remove(dirname(file), { recursive: true, force: true })
    }
  })
  it('uses a private pgpass file, verified TLS and removes credentials after success', async () => {
    let passwordFile = ''
    jest.mocked(spawn).mockImplementation((_binary, _args, opts: any) => {
      passwordFile = opts.env.PGPASSFILE
      expect(statSync(passwordFile).mode & 0o777).toBe(0o600)
      expect(statSync(dirname(passwordFile)).mode & 0o777).toBe(0o700)
      expect(readFileSync(passwordFile, 'utf8')).toBe('db.example.com:5432:app:backup:p\\:a\\\\ss"word\n')
      expect(opts.env.PGSSLMODE).toBe('verify-full')
      expect(opts.env.PGGSSENCMODE).toBe('disable')
      expect(opts.env.PGPASSWORD).toBeUndefined()
      expect(opts.shell).toBe(false)
      const process = child(); setImmediate(() => { process.stdout.end('dump'); process.emit('close', 0, null) }); return process as never
    })
    expect((await collect(streamDatabaseDump(connection(), options))).toString()).toBe('dump')
    expect(JSON.stringify(jest.mocked(spawn).mock.calls[0][1])).not.toContain(connection().password)
    expect(existsSync(dirname(passwordFile))).toBe(false)
  })
  it('uses an isolated MySQL option file without user login paths', async () => {
    let file = ''
    jest.mocked(spawn).mockImplementation((binary, args: any) => {
      expect(binary).toBe('mysqldump')
      file = args[0].replace('--defaults-file=', '')
      expect(readFileSync(file, 'utf8')).toContain('password="p:a\\\\ss\\"word"')
      expect(args).toEqual(expect.arrayContaining(['--no-login-paths', '--single-transaction', '--ssl-mode=VERIFY_IDENTITY', '--databases', '--', 'app']))
      const process = child(); setImmediate(() => { process.stdout.end('sql'); process.emit('close', 0, null) }); return process as never
    })
    await collect(streamDatabaseDump({ ...connection(), engine: 'mysql', port: 3306, mysqlConsistency: 'innodb-no-ddl' }, options))
    expect(execFile).toHaveBeenCalledWith('mysql', expect.arrayContaining(['--ssl-mode=VERIFY_IDENTITY', '--database=app']), expect.objectContaining({ shell: false, maxBuffer: 1024, killSignal: 'SIGKILL' }), expect.any(Function))
    expect(existsSync(dirname(file))).toBe(false)
  })
  it('requires an explicit MySQL consistency mode before running any client', async () => {
    await expect(collect(streamDatabaseDump({ ...connection(), engine: 'mysql' }, options))).rejects.toThrow('BACKUP_DUMP_INVALID_CONFIGURATION')
    expect(execFile).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled()
  })
  it('refuses non-InnoDB tables in the nonblocking mode', async () => {
    jest.mocked(execFile).mockImplementation((...args: any[]) => preflight(args, '1\n'))
    await expect(collect(streamDatabaseDump({ ...connection(), engine: 'mysql', mysqlConsistency: 'innodb-no-ddl' }, options))).rejects.toThrow('BACKUP_MYSQL_NON_TRANSACTIONAL_TABLES')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('uses a global read lock only when explicitly configured', async () => {
    jest.mocked(spawn).mockImplementation((_binary, args: any) => {
      expect(args).toContain('--lock-all-tables'); expect(args).not.toContain('--single-transaction')
      const process = child(); setImmediate(() => { process.stdout.end('sql'); process.emit('close', 0, null) }); return process as never
    })
    await collect(streamDatabaseDump({ ...connection(), engine: 'mysql', mysqlConsistency: 'global-read-lock' }, options))
    expect(execFile).not.toHaveBeenCalled()
  })
  it('waits for a failed preflight process to exit before deleting credentials', async () => {
    const process = child(); let file = ''
    jest.mocked(execFile).mockImplementation((...args: any[]) => {
      file = args[1][0].replace('--defaults-file=', '')
      setImmediate(() => args[args.length - 1](new Error('secret error'), '', ''))
      return process as never
    })
    await expect(collect(streamDatabaseDump({ ...connection(), engine: 'mysql', mysqlConsistency: 'innodb-no-ddl' }, options))).rejects.toThrow('BACKUP_MYSQL_PREFLIGHT_FAILED')
    expect(process.kill).toHaveBeenCalled()
    expect(existsSync(dirname(file))).toBe(false)
  })
  it('rejects a nonzero exit even after stdout ended and never exposes stderr', async () => {
    jest.mocked(spawn).mockImplementation(() => {
      const process = child(); setImmediate(() => { process.stderr.write('secret database password'); process.stdout.end('partial'); process.emit('close', 1, null) }); return process as never
    })
    await expect(collect(streamDatabaseDump(connection(), options))).rejects.toThrow(/^BACKUP_DUMP_FAILED$/)
  })
  it.each([{ database: 'host=other password=secret' }, { password: 'line\nbreak' }, { caPem: 'invalid' }])('validates connection before spawning (%#)', async (change) => {
    await expect(collect(streamDatabaseDump({ ...connection(), ...change }, options))).rejects.toThrow('BACKUP_DUMP_INVALID_CONFIGURATION')
    expect(spawn).not.toHaveBeenCalled()
  })
  it('terminates the child and removes credentials when the consumer stops early', async () => {
    const process = child(); let file = ''
    jest.mocked(spawn).mockImplementation((_binary, _args, opts: any) => { file = opts.env.PGPASSFILE; setImmediate(() => process.stdout.write('part')); return process as never })
    for await (const _chunk of streamDatabaseDump(connection(), options)) break
    expect(process.kill).toHaveBeenCalledWith('SIGTERM')
    expect(existsSync(dirname(file))).toBe(false)
  })
  it('stops a hung dump on timeout', async () => {
    const process = child(); jest.mocked(spawn).mockReturnValue(process as never)
    await expect(collect(streamDatabaseDump(connection(), { ...options, timeoutMs: 20 }))).rejects.toThrow('BACKUP_EXPORT_TIMEOUT')
    expect(process.kill).toHaveBeenCalled()
  })
  it('cancels an in-flight dump and deletes its credential file', async () => {
    const process = child(); const controller = new AbortController(); let file = ''
    jest.mocked(spawn).mockImplementation((_binary, _args, opts: any) => {
      file = opts.env.PGPASSFILE
      setImmediate(() => controller.abort())
      return process as never
    })
    await expect(collect(streamDatabaseDump(connection(), { ...options, signal: controller.signal }))).rejects.toThrow(/^BACKUP_EXPORT_ABORTED$/)
    expect(process.kill).toHaveBeenCalledWith('SIGTERM')
    expect(existsSync(dirname(file))).toBe(false)
  })
  it('sanitizes process start failure and deletes its credential file', async () => {
    const process = child(); let file = ''
    jest.mocked(spawn).mockImplementation((_binary, _args, opts: any) => {
      file = opts.env.PGPASSFILE
      setImmediate(() => { process.emit('error', new Error('spawn ENOENT sensitive path')); process.emit('close', -2) })
      return process as never
    })
    await expect(collect(streamDatabaseDump(connection(), options))).rejects.toThrow(/^BACKUP_DUMP_FAILED$/)
    expect(existsSync(dirname(file))).toBe(false)
  })
  it('rejects oversized stdout and aborts the producer', async () => {
    const process = child(); jest.mocked(spawn).mockImplementation(() => { setImmediate(() => process.stdout.write(Buffer.alloc(20))); return process as never })
    await expect(collect(streamDatabaseDump(connection(), { ...options, maxBytes: 10 }))).rejects.toThrow('BACKUP_EXPORT_SIZE_LIMIT')
    expect(process.kill).toHaveBeenCalled()
  })
})
