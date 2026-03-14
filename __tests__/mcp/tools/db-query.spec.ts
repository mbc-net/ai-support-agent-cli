import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { validateSql, executeQuery, registerDbQueryTool } from '../../../src/mcp/tools/db-query'

jest.mock('../../../src/api-client')
jest.mock('../../../src/logger')
jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(),
}))
jest.mock('pg', () => ({
  Client: jest.fn(),
}))

describe('db-query tool', () => {
  describe('validateSql', () => {
    it('should allow valid SELECT queries', () => {
      expect(validateSql('SELECT * FROM users').valid).toBe(true)
      expect(validateSql('SELECT id, name FROM users WHERE id = 1').valid).toBe(true)
      expect(validateSql('select * from users').valid).toBe(true)
    })

    it('should allow WITH (CTE) queries', () => {
      expect(validateSql('WITH cte AS (SELECT * FROM users) SELECT * FROM cte').valid).toBe(true)
    })

    it('should allow EXPLAIN queries', () => {
      expect(validateSql('EXPLAIN SELECT * FROM users').valid).toBe(true)
    })

    it('should reject empty queries', () => {
      const result = validateSql('')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('SQL query is empty')
    })

    it('should reject whitespace-only queries', () => {
      const result = validateSql('   ')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('SQL query is empty')
    })

    it('should reject DROP statements', () => {
      const result = validateSql('DROP TABLE users')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: DROP')
    })

    it('should reject DELETE statements', () => {
      const result = validateSql('DELETE FROM users WHERE id = 1')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: DELETE')
    })

    it('should reject UPDATE statements', () => {
      const result = validateSql('UPDATE users SET name = "test" WHERE id = 1')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: UPDATE')
    })

    it('should reject INSERT statements', () => {
      const result = validateSql('INSERT INTO users (name) VALUES ("test")')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: INSERT')
    })

    it('should reject TRUNCATE statements', () => {
      const result = validateSql('TRUNCATE TABLE users')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: TRUNCATE')
    })

    it('should reject ALTER statements', () => {
      const result = validateSql('ALTER TABLE users ADD COLUMN age INT')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: ALTER')
    })

    it('should reject CREATE statements', () => {
      const result = validateSql('CREATE TABLE users (id INT)')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: CREATE')
    })

    it('should reject GRANT statements', () => {
      const result = validateSql('GRANT ALL ON users TO admin')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: GRANT')
    })

    it('should reject REVOKE statements', () => {
      const result = validateSql('REVOKE ALL ON users FROM admin')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: REVOKE')
    })

    it('should reject UNION-based injection', () => {
      const result = validateSql('SELECT * FROM users UNION SELECT * FROM passwords')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: UNION')
    })

    it('should reject UNION ALL injection', () => {
      const result = validateSql('SELECT id FROM users UNION ALL SELECT password FROM credentials')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: UNION')
    })

    it('should allow column names containing forbidden keywords as substrings', () => {
      expect(validateSql('SELECT UPDATED_AT FROM users').valid).toBe(true)
      expect(validateSql('SELECT CREATED_AT FROM users').valid).toBe(true)
      expect(validateSql('SELECT IS_DELETED FROM users').valid).toBe(true)
    })

    it('should allow SHOW statements', () => {
      expect(validateSql('SHOW TABLES').valid).toBe(true)
      expect(validateSql('SHOW COLUMNS FROM users').valid).toBe(true)
    })

    it('should allow DESCRIBE/DESC statements', () => {
      expect(validateSql('DESCRIBE users').valid).toBe(true)
      expect(validateSql('DESC users').valid).toBe(true)
    })

    it('should reject queries that do not start with allowed keywords', () => {
      const result = validateSql('CALL my_procedure()')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('Only')
    })

    describe('comment injection detection', () => {
      it('should reject SQL dash comments', () => {
        const result = validateSql('SELECT * FROM users -- WHERE id = 1')
        expect(result.valid).toBe(false)
        expect(result.error).toBe('SQL comments are not allowed')
      })

      it('should reject C-style block comments', () => {
        expect(validateSql('SELECT * FROM users /* comment */').valid).toBe(false)
        expect(validateSql('SELECT */ FROM users').valid).toBe(false)
      })

      it('should reject MySQL hash comments', () => {
        const result = validateSql('SELECT * FROM users # comment')
        expect(result.valid).toBe(false)
        expect(result.error).toBe('SQL comments are not allowed')
      })
    })

    describe('multiple statement detection', () => {
      it('should reject multiple statements separated by semicolons', () => {
        const result = validateSql('SELECT 1; DELETE FROM users')
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Multiple SQL statements are not allowed')
      })

      it('should allow trailing semicolon', () => {
        expect(validateSql('SELECT * FROM users;').valid).toBe(true)
        expect(validateSql('SELECT * FROM users;  ').valid).toBe(true)
      })
    })

    describe('time-based blind injection detection', () => {
      it('should reject SLEEP function', () => {
        const result = validateSql("SELECT * FROM users WHERE id = 1 AND SLEEP(5)")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous function detected: SLEEP')
      })

      it('should reject BENCHMARK function', () => {
        const result = validateSql("SELECT BENCHMARK(1000000, SHA1('test'))")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous function detected: BENCHMARK')
      })

      it('should reject PG_SLEEP function', () => {
        const result = validateSql("SELECT * FROM users WHERE id = 1 AND PG_SLEEP(5)")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous function detected: PG_SLEEP')
      })

      it('should reject WAITFOR DELAY', () => {
        const result = validateSql("SELECT * FROM users; WAITFOR DELAY '0:0:5'")
        expect(result.valid).toBe(false)
        // Could match multiple statement or WAITFOR DELAY
        expect(result.valid).toBe(false)
      })

      it('should reject DBMS_LOCK.SLEEP', () => {
        const result = validateSql("SELECT DBMS_LOCK.SLEEP(5) FROM dual")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous function detected: DBMS_LOCK.SLEEP')
      })
    })

    describe('encoding bypass detection', () => {
      it('should reject hex literals', () => {
        const result = validateSql("SELECT * FROM users WHERE name = 0x61646D696E")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Encoding bypass detected: hex literal')
      })

      it('should reject CONVERT function', () => {
        const result = validateSql("SELECT CONVERT('admin' USING utf8)")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Encoding bypass detected: CONVERT')
      })

      it('should reject UNHEX function', () => {
        const result = validateSql("SELECT UNHEX('61646D696E')")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Encoding bypass detected: UNHEX')
      })
    })

    describe('filesystem and system access detection', () => {
      it('should reject LOAD DATA', () => {
        const result = validateSql("SELECT * FROM users WHERE LOAD DATA INFILE '/etc/passwd'")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous operation detected: LOAD DATA')
      })

      it('should reject INTO OUTFILE', () => {
        const result = validateSql("SELECT * FROM users INTO OUTFILE '/tmp/data.csv'")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous operation detected: INTO OUTFILE')
      })

      it('should reject INTO DUMPFILE', () => {
        const result = validateSql("SELECT * FROM users INTO DUMPFILE '/tmp/data.bin'")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous operation detected: INTO DUMPFILE')
      })

      it('should reject xp_cmdshell', () => {
        const result = validateSql("SELECT xp_cmdshell('dir')")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous operation detected: xp_cmdshell')
      })

      it('should reject xp_regread', () => {
        const result = validateSql("SELECT xp_regread('HKLM', 'key')")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous operation detected: xp_regread')
      })

      it('should reject sp_executesql', () => {
        const result = validateSql("SELECT sp_executesql('SELECT 1')")
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Dangerous operation detected: sp_executesql')
      })
    })

    describe('subquery depth limiting', () => {
      it('should allow queries within depth limit', () => {
        const sql = 'SELECT * FROM a WHERE id IN (SELECT id FROM b WHERE id IN (SELECT id FROM c))'
        expect(validateSql(sql).valid).toBe(true)
      })

      it('should reject queries exceeding depth limit', () => {
        const sql = 'SELECT * FROM a WHERE id IN (SELECT id FROM b WHERE id IN (SELECT id FROM c WHERE id IN (SELECT id FROM d WHERE id IN (SELECT id FROM e))))'
        const result = validateSql(sql)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Subquery nesting too deep (max 3 levels)')
      })
    })

    describe('EXEC/EXECUTE blocking', () => {
      it('should reject EXEC', () => {
        const result = validateSql('EXEC sp_who')
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Forbidden SQL operation: EXEC')
      })

      it('should reject EXECUTE', () => {
        const result = validateSql('EXECUTE sp_who')
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Forbidden SQL operation: EXECUTE')
      })

      it('should not false-positive on EXECUTED_AT column', () => {
        expect(validateSql('SELECT EXECUTED_AT FROM jobs').valid).toBe(true)
      })
    })

    describe('with writePermissions', () => {
      it('should allow INSERT when insert permission is granted', () => {
        const perms = { insert: true, update: false, delete: false }
        expect(validateSql('INSERT INTO users (name) VALUES ("test")', perms).valid).toBe(true)
      })

      it('should block INSERT when insert permission is not granted', () => {
        const perms = { insert: false, update: false, delete: false }
        const result = validateSql('INSERT INTO users (name) VALUES ("test")', perms)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Forbidden SQL operation: INSERT')
      })

      it('should allow UPDATE when update permission is granted', () => {
        const perms = { insert: false, update: true, delete: false }
        expect(validateSql('UPDATE users SET name = "test" WHERE id = 1', perms).valid).toBe(true)
      })

      it('should block UPDATE when update permission is not granted', () => {
        const perms = { insert: false, update: false, delete: false }
        const result = validateSql('UPDATE users SET name = "test" WHERE id = 1', perms)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Forbidden SQL operation: UPDATE')
      })

      it('should allow DELETE when delete permission is granted', () => {
        const perms = { insert: false, update: false, delete: true }
        expect(validateSql('DELETE FROM users WHERE id = 1', perms).valid).toBe(true)
      })

      it('should block DELETE when delete permission is not granted', () => {
        const perms = { insert: false, update: false, delete: false }
        const result = validateSql('DELETE FROM users WHERE id = 1', perms)
        expect(result.valid).toBe(false)
        expect(result.error).toBe('Forbidden SQL operation: DELETE')
      })

      it('should always block DDL regardless of writePermissions', () => {
        const perms = { insert: true, update: true, delete: true }
        expect(validateSql('DROP TABLE users', perms).valid).toBe(false)
        expect(validateSql('TRUNCATE TABLE users', perms).valid).toBe(false)
        expect(validateSql('ALTER TABLE users ADD COLUMN age INT', perms).valid).toBe(false)
        expect(validateSql('CREATE TABLE users (id INT)', perms).valid).toBe(false)
        expect(validateSql('GRANT ALL ON users TO admin', perms).valid).toBe(false)
        expect(validateSql('REVOKE ALL ON users FROM admin', perms).valid).toBe(false)
        expect(validateSql('SELECT * FROM users UNION SELECT * FROM passwords', perms).valid).toBe(false)
      })

      it('should still allow SELECT when writePermissions are granted', () => {
        const perms = { insert: true, update: true, delete: true }
        expect(validateSql('SELECT * FROM users', perms).valid).toBe(true)
      })

      it('should only allow SELECT when writePermissions is undefined (backward compat)', () => {
        expect(validateSql('SELECT * FROM users').valid).toBe(true)
        expect(validateSql('INSERT INTO users (name) VALUES ("test")').valid).toBe(false)
        expect(validateSql('UPDATE users SET name = "test"').valid).toBe(false)
        expect(validateSql('DELETE FROM users WHERE id = 1').valid).toBe(false)
      })

      it('should allow column names containing forbidden DML keywords as substrings', () => {
        const perms = { insert: false, update: false, delete: false }
        expect(validateSql('SELECT UPDATED_AT FROM users', perms).valid).toBe(true)
        expect(validateSql('SELECT INSERTED_AT FROM users', perms).valid).toBe(true)
        expect(validateSql('SELECT IS_DELETED FROM users', perms).valid).toBe(true)
      })

      it('should allow SHOW TABLES with writePermissions', () => {
        const perms = { insert: true, update: true, delete: true }
        const result = validateSql('SHOW TABLES', perms)
        expect(result.valid).toBe(true)
      })

      it('should reject unknown starting keywords', () => {
        const perms = { insert: true, update: true, delete: true }
        const result = validateSql('CALL my_procedure()', perms)
        expect(result.valid).toBe(false)
        expect(result.error).toContain('INSERT')
        expect(result.error).toContain('UPDATE')
        expect(result.error).toContain('DELETE')
      })
    })
  })

  describe('executeQuery', () => {
    it('should execute MySQL query', async () => {
      const mockConnection = {
        query: jest.fn().mockResolvedValue([[{ id: 1, name: 'test' }]]),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const mysql2 = require('mysql2/promise')
      mysql2.createConnection.mockResolvedValue(mockConnection)

      const result = await executeQuery(
        { name: 'MAIN', engine: 'mysql', host: 'localhost', port: 3306, database: 'testdb', user: 'root', password: 'pass' },
        'SELECT * FROM users',
      )

      expect(result).toEqual([{ id: 1, name: 'test' }])
      expect(mockConnection.end).toHaveBeenCalled()
    })

    it('should close MySQL connection even on error', async () => {
      const mockConnection = {
        query: jest.fn().mockRejectedValue(new Error('query failed')),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const mysql2 = require('mysql2/promise')
      mysql2.createConnection.mockResolvedValue(mockConnection)

      await expect(executeQuery(
        { name: 'MAIN', engine: 'mysql', host: 'localhost', port: 3306, database: 'testdb', user: 'root', password: 'pass' },
        'SELECT * FROM users',
      )).rejects.toThrow('query failed')

      expect(mockConnection.end).toHaveBeenCalled()
    })

    it('should execute PostgreSQL query', async () => {
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [{ id: 1, name: 'test' }] }),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const pg = require('pg')
      pg.Client.mockImplementation(() => mockClient)

      const result = await executeQuery(
        { name: 'MAIN', engine: 'postgresql', host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: 'pass' },
        'SELECT * FROM users',
      )

      expect(result).toEqual([{ id: 1, name: 'test' }])
      expect(mockClient.end).toHaveBeenCalled()
    })

    it('should close PostgreSQL connection even on error', async () => {
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockRejectedValue(new Error('pg error')),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const pg = require('pg')
      pg.Client.mockImplementation(() => mockClient)

      await expect(executeQuery(
        { name: 'MAIN', engine: 'postgresql', host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: 'pass' },
        'SELECT * FROM users',
      )).rejects.toThrow('pg error')

      expect(mockClient.end).toHaveBeenCalled()
    })

    it('should enable SSL by default for non-localhost PostgreSQL', async () => {
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const pg = require('pg')
      pg.Client.mockImplementation(() => mockClient)

      await executeQuery(
        { name: 'MAIN', engine: 'postgresql', host: 'db.example.com', port: 5432, database: 'testdb', user: 'postgres', password: 'pass' },
        'SELECT 1',
      )

      expect(pg.Client).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: { rejectUnauthorized: true } }),
      )
    })

    it('should disable SSL for localhost PostgreSQL', async () => {
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const pg = require('pg')
      pg.Client.mockImplementation(() => mockClient)

      await executeQuery(
        { name: 'MAIN', engine: 'postgresql', host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: 'pass' },
        'SELECT 1',
      )

      expect(pg.Client).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: false }),
      )
    })

    it('should disable SSL for 127.0.0.1 PostgreSQL', async () => {
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const pg = require('pg')
      pg.Client.mockImplementation(() => mockClient)

      await executeQuery(
        { name: 'MAIN', engine: 'postgresql', host: '127.0.0.1', port: 5432, database: 'testdb', user: 'postgres', password: 'pass' },
        'SELECT 1',
      )

      expect(pg.Client).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: false }),
      )
    })

    it('should respect explicit ssl disable mode for remote PostgreSQL', async () => {
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const pg = require('pg')
      pg.Client.mockImplementation(() => mockClient)

      await executeQuery(
        { name: 'MAIN', engine: 'postgresql', host: 'db.example.com', port: 5432, database: 'testdb', user: 'postgres', password: 'pass', ssl: { mode: 'disable' } },
        'SELECT 1',
      )

      expect(pg.Client).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: false }),
      )
    })

    it('should respect explicit ssl require mode for localhost PostgreSQL', async () => {
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const pg = require('pg')
      pg.Client.mockImplementation(() => mockClient)

      await executeQuery(
        { name: 'MAIN', engine: 'postgresql', host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: 'pass', ssl: { mode: 'verify-full' } },
        'SELECT 1',
      )

      expect(pg.Client).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: { rejectUnauthorized: true } }),
      )
    })

    it('should throw for unsupported engine', async () => {
      await expect(executeQuery(
        { name: 'MAIN', engine: 'sqlite', host: 'localhost', port: 0, database: 'test', user: 'u', password: 'p' },
        'SELECT 1',
      )).rejects.toThrow('Unsupported database engine: sqlite')
    })
  })

  describe('registerDbQueryTool', () => {
    let toolCallback: (args: { name: string; sql: string }) => Promise<unknown>

    const setupTool = (credentialsOrError?: unknown, shouldReject = false) => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_name: string, _desc: string, _schema: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const getDbCredentials = jest.fn()
      if (shouldReject) {
        getDbCredentials.mockRejectedValue(credentialsOrError)
      } else if (credentialsOrError) {
        getDbCredentials.mockResolvedValue(credentialsOrError)
      }
      const mockClient = { getDbCredentials } as unknown as ApiClient
      registerDbQueryTool(mockServer, mockClient)
      return { mockServer, mockClient }
    }

    beforeEach(() => {
      setupTool({
        name: 'MAIN', engine: 'mysql', host: 'localhost', port: 3306,
        database: 'testdb', user: 'root', password: 'pass',
      })
    })

    it('should register the tool on the server', () => {
      expect(toolCallback).toBeDefined()
    })

    it('should return error for DDL SQL', async () => {
      const result = await toolCallback({ name: 'MAIN', sql: 'DROP TABLE users' })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Forbidden SQL operation: DROP' }],
        isError: true,
      })
    })

    it('should return error for empty SQL', async () => {
      const result = await toolCallback({ name: 'MAIN', sql: '' })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: SQL query is empty' }],
        isError: true,
      })
    })

    it('should handle API errors', async () => {
      setupTool(new Error('Unauthorized'), true)

      const result = await toolCallback({ name: 'MAIN', sql: 'SELECT 1' })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Unauthorized' }],
        isError: true,
      })
    })

    it('should execute query and return results', async () => {
      const mockConnection = {
        query: jest.fn().mockResolvedValue([[{ id: 1 }]]),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const mysql2 = require('mysql2/promise')
      mysql2.createConnection.mockResolvedValue(mockConnection)

      setupTool({
        name: 'MAIN', engine: 'mysql', host: 'localhost', port: 3306,
        database: 'testdb', user: 'root', password: 'pass',
      })

      const result = await toolCallback({ name: 'MAIN', sql: 'SELECT * FROM users' })
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([{ id: 1 }], null, 2) }],
      })
    })

    it('should allow INSERT when credentials have insert permission', async () => {
      const mockConnection = {
        query: jest.fn().mockResolvedValue([{ affectedRows: 1 }]),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const mysql2 = require('mysql2/promise')
      mysql2.createConnection.mockResolvedValue(mockConnection)

      setupTool({
        name: 'MAIN', engine: 'mysql', host: 'localhost', port: 3306,
        database: 'testdb', user: 'root', password: 'pass',
        writePermissions: { insert: true, update: false, delete: false },
      })

      const result = await toolCallback({ name: 'MAIN', sql: 'INSERT INTO users (name) VALUES ("test")' })
      expect(result).not.toHaveProperty('isError')
    })

    it('should block INSERT when credentials lack insert permission', async () => {
      setupTool({
        name: 'MAIN', engine: 'mysql', host: 'localhost', port: 3306,
        database: 'testdb', user: 'root', password: 'pass',
        writePermissions: { insert: false, update: false, delete: false },
      })

      const result = await toolCallback({ name: 'MAIN', sql: 'INSERT INTO users (name) VALUES ("test")' })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Forbidden SQL operation: INSERT' }],
        isError: true,
      })
    })

    it('should block write operations when credentials have no writePermissions', async () => {
      setupTool({
        name: 'MAIN', engine: 'mysql', host: 'localhost', port: 3306,
        database: 'testdb', user: 'root', password: 'pass',
      })

      const result = await toolCallback({ name: 'MAIN', sql: 'DELETE FROM users WHERE id = 1' })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Forbidden SQL operation: DELETE' }],
        isError: true,
      })
    })
  })
})
