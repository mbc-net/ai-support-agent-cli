import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { streamDatabaseDump } from '../../src/backup/backup-database-dump'

const caFile = process.env.BYO_BACKUP_MYSQL_TEST_CA
const port = process.env.BYO_BACKUP_MYSQL_TEST_PORT ?? '55441'
const integration = caFile ? describe : describe.skip

integration('database dump with real MySQL over TLS', () => {
  it.each(['innodb-no-ddl', 'global-read-lock'] as const)('restores schema and rows using %s and a punctuation-rich password', async (mysqlConsistency) => {
    const suffix = randomUUID().replace(/-/g, '')
    const database = `backup_fixture_${suffix}`
    const username = `backup_${suffix.slice(0, 16)}`
    const password = 'p:a\\ss"word#;'
    const args = ['--no-defaults', '--no-login-paths', '--protocol=TCP', '--host=127.0.0.1', `--port=${port}`, '--user=root', '--ssl-mode=VERIFY_IDENTITY', `--ssl-ca=${caFile}`, '--batch', '--skip-column-names']
    const env = { PATH: process.env.PATH, MYSQL_PWD: 'byo-test-only' }
    const sql = (command: string) => execFileSync('mysql', args, { input: command, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      // Hex decoding preserves every test-password byte independently of SQL escaping modes.
      sql(`CREATE DATABASE ${database}; SET @password=CONVERT(0x${Buffer.from(password).toString('hex')} USING utf8mb4); SET @statement=CONCAT('CREATE USER ''${username}''@''%'' IDENTIFIED BY ', QUOTE(@password)); PREPARE stmt FROM @statement; EXECUTE stmt; DEALLOCATE PREPARE stmt;`)
      sql(`GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON ${database}.* TO '${username}'@'%'; GRANT SHOW_ROUTINE ON *.* TO '${username}'@'%'; CREATE TABLE ${database}.items (id INT PRIMARY KEY, value TEXT) ENGINE=InnoDB; INSERT INTO ${database}.items VALUES (1, 'verified mysql row');`)
      const connection = { engine: 'mysql' as const, host: '127.0.0.1', port: Number(port), username, password,
        database, caPem: await readFile(caFile!, 'utf8'), mysqlConsistency }
      sql(`CREATE TABLE ${database}.legacy (id INT PRIMARY KEY) ENGINE=MyISAM; INSERT INTO ${database}.legacy VALUES (1);`)
      if (mysqlConsistency === 'innodb-no-ddl') {
        const rejected = async () => { for await (const _part of streamDatabaseDump(connection, { maxBytes: 10 * 1024 * 1024, timeoutMs: 30000 })) { /* drain */ } }
        await expect(rejected()).rejects.toThrow('BACKUP_MYSQL_NON_TRANSACTIONAL_TABLES')
        sql(`DROP TABLE ${database}.legacy;`)
      } else {
        sql(`GRANT RELOAD ON *.* TO '${username}'@'%';`)
      }
      const parts: Buffer[] = []
      for await (const part of streamDatabaseDump(connection, { maxBytes: 10 * 1024 * 1024, timeoutMs: 30000 })) parts.push(part)
      const dump = Buffer.concat(parts)
      expect(dump.toString()).toContain('CREATE TABLE')
      sql(`DROP DATABASE ${database};`)
      sql(dump.toString())
      expect(sql(`SELECT value FROM ${database}.items WHERE id=1;`).trim()).toBe('verified mysql row')
      if (mysqlConsistency === 'global-read-lock') expect(sql(`SELECT id FROM ${database}.legacy;`).trim()).toBe('1')
    } finally {
      sql(`DROP DATABASE IF EXISTS ${database};`)
      sql(`DROP USER IF EXISTS '${username}'@'%';`)
    }
  })
})
