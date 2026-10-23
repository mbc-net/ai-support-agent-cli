import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { streamDatabaseDump } from '../../src/backup/backup-database-dump'
import { TEST_CA_PEM } from '../fixtures/rdp-trusted-ca-pems'

const caFile = process.env.BYO_BACKUP_PG_TEST_CA
const port = process.env.BYO_BACKUP_PG_TEST_PORT ?? '55440'
const integration = caFile ? describe : describe.skip

integration('database dump with real PostgreSQL over TLS', () => {
  it('rejects a server whose certificate is not signed by the configured CA', async () => {
    const dump = async () => {
      for await (const _part of streamDatabaseDump({
        engine: 'postgres', host: '127.0.0.1', port: Number(port), username: 'postgres', password: 'byo-test-only',
        database: 'backup_test', caPem: TEST_CA_PEM,
      }, { maxBytes: 10 * 1024 * 1024, timeoutMs: 30000 })) { /* drain */ }
    }
    await expect(dump()).rejects.toThrow(/^BACKUP_DUMP_FAILED$/)
  })
  it('dumps rows and schema then restores them into a separate test database', async () => {
    const suffix = randomUUID().replace(/-/g, '')
    const table = `backup_fixture_${suffix}`
    const restored = `backup_restore_${suffix}`
    const env = { PATH: process.env.PATH, PGPASSWORD: 'byo-test-only', PGSSLMODE: 'verify-full', PGSSLROOTCERT: caFile! }
    const args = ['--host=127.0.0.1', `--port=${port}`, '--username=postgres']
    const sql = (database: string, command: string) => execFileSync('psql', [...args, `--dbname=${database}`, '-v', 'ON_ERROR_STOP=1', '-At', '-c', command], { env, encoding: 'utf8' })
    const directory = await mkdtemp(join(tmpdir(), 'byo-dump-test-'))
    let created = false
    try {
      sql('backup_test', `CREATE TABLE ${table}(id integer PRIMARY KEY, value text NOT NULL); INSERT INTO ${table} VALUES (1, 'verified backup row');`)
      const parts: Buffer[] = []
      for await (const part of streamDatabaseDump({
        engine: 'postgres', host: '127.0.0.1', port: Number(port), username: 'postgres', password: 'byo-test-only',
        database: 'backup_test', caPem: await readFile(caFile!, 'utf8'),
      }, { maxBytes: 10 * 1024 * 1024, timeoutMs: 30000 })) parts.push(part)
      const dump = Buffer.concat(parts)
      expect(dump.subarray(0, 5).toString()).toBe('PGDMP')
      const file = join(directory, 'test.dump')
      await writeFile(file, dump, { mode: 0o600 })
      sql('postgres', `CREATE DATABASE ${restored}`)
      created = true
      execFileSync('pg_restore', [...args, `--dbname=${restored}`, '--exit-on-error', file], { env, stdio: 'pipe' })
      expect(sql(restored, `SELECT value FROM ${table} WHERE id=1`).trim()).toBe('verified backup row')
    } finally {
      if (created) sql('postgres', `DROP DATABASE ${restored}`)
      sql('backup_test', `DROP TABLE IF EXISTS ${table}`)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
