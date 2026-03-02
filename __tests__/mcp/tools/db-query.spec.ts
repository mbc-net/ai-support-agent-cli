import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { validateSelectOnly, executeQuery, registerDbQueryTool } from '../../../src/mcp/tools/db-query'

jest.mock('../../../src/api-client')
jest.mock('../../../src/logger')
jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn(),
}))
jest.mock('pg', () => ({
  Client: jest.fn(),
}))

describe('db-query tool', () => {
  describe('validateSelectOnly', () => {
    it('should allow valid SELECT queries', () => {
      expect(validateSelectOnly('SELECT * FROM users').valid).toBe(true)
      expect(validateSelectOnly('SELECT id, name FROM users WHERE id = 1').valid).toBe(true)
      expect(validateSelectOnly('select * from users').valid).toBe(true)
    })

    it('should allow WITH (CTE) queries', () => {
      expect(validateSelectOnly('WITH cte AS (SELECT * FROM users) SELECT * FROM cte').valid).toBe(true)
    })

    it('should allow EXPLAIN queries', () => {
      expect(validateSelectOnly('EXPLAIN SELECT * FROM users').valid).toBe(true)
    })

    it('should reject empty queries', () => {
      const result = validateSelectOnly('')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('SQL query is empty')
    })

    it('should reject whitespace-only queries', () => {
      const result = validateSelectOnly('   ')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('SQL query is empty')
    })

    it('should reject DROP statements', () => {
      const result = validateSelectOnly('DROP TABLE users')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: DROP')
    })

    it('should reject DELETE statements', () => {
      const result = validateSelectOnly('DELETE FROM users WHERE id = 1')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: DELETE')
    })

    it('should reject UPDATE statements', () => {
      const result = validateSelectOnly('UPDATE users SET name = "test" WHERE id = 1')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: UPDATE')
    })

    it('should reject INSERT statements', () => {
      const result = validateSelectOnly('INSERT INTO users (name) VALUES ("test")')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: INSERT')
    })

    it('should reject TRUNCATE statements', () => {
      const result = validateSelectOnly('TRUNCATE TABLE users')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: TRUNCATE')
    })

    it('should reject ALTER statements', () => {
      const result = validateSelectOnly('ALTER TABLE users ADD COLUMN age INT')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: ALTER')
    })

    it('should reject CREATE statements', () => {
      const result = validateSelectOnly('CREATE TABLE users (id INT)')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: CREATE')
    })

    it('should reject GRANT statements', () => {
      const result = validateSelectOnly('GRANT ALL ON users TO admin')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: GRANT')
    })

    it('should reject REVOKE statements', () => {
      const result = validateSelectOnly('REVOKE ALL ON users FROM admin')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Forbidden SQL operation: REVOKE')
    })

    it('should allow column names containing forbidden keywords as substrings', () => {
      expect(validateSelectOnly('SELECT UPDATED_AT FROM users').valid).toBe(true)
      expect(validateSelectOnly('SELECT CREATED_AT FROM users').valid).toBe(true)
      expect(validateSelectOnly('SELECT IS_DELETED FROM users').valid).toBe(true)
    })

    it('should reject queries that do not start with SELECT/WITH/EXPLAIN', () => {
      const result = validateSelectOnly('SHOW TABLES')
      expect(result.valid).toBe(false)
      expect(result.error).toBe('Only SELECT, WITH, and EXPLAIN statements are allowed')
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

    it('should respect explicit ssl=false override for remote PostgreSQL', async () => {
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const pg = require('pg')
      pg.Client.mockImplementation(() => mockClient)

      await executeQuery(
        { name: 'MAIN', engine: 'postgresql', host: 'db.example.com', port: 5432, database: 'testdb', user: 'postgres', password: 'pass', ssl: false },
        'SELECT 1',
      )

      expect(pg.Client).toHaveBeenCalledWith(
        expect.objectContaining({ ssl: false }),
      )
    })

    it('should respect explicit ssl=true override for localhost PostgreSQL', async () => {
      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [] }),
        end: jest.fn().mockResolvedValue(undefined),
      }
      const pg = require('pg')
      pg.Client.mockImplementation(() => mockClient)

      await executeQuery(
        { name: 'MAIN', engine: 'postgresql', host: 'localhost', port: 5432, database: 'testdb', user: 'postgres', password: 'pass', ssl: true },
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

    beforeEach(() => {
      const mockServer = {
        tool: jest.fn().mockImplementation((_name: string, _desc: string, _schema: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        getDbCredentials: jest.fn(),
      } as unknown as ApiClient

      registerDbQueryTool(mockServer, mockClient)
    })

    it('should register the tool on the server', () => {
      expect(toolCallback).toBeDefined()
    })

    it('should return error for invalid SQL', async () => {
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
      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        getDbCredentials: jest.fn().mockRejectedValue(new Error('Unauthorized')),
      } as unknown as ApiClient

      registerDbQueryTool(mockServer, mockClient)

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

      const mockServer = {
        tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        }),
      } as unknown as McpServer
      const mockClient = {
        getDbCredentials: jest.fn().mockResolvedValue({
          name: 'MAIN', engine: 'mysql', host: 'localhost', port: 3306,
          database: 'testdb', user: 'root', password: 'pass',
        }),
      } as unknown as ApiClient

      registerDbQueryTool(mockServer, mockClient)

      const result = await toolCallback({ name: 'MAIN', sql: 'SELECT * FROM users' })
      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify([{ id: 1 }], null, 2) }],
      })
    })
  })
})
