import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import type { DbCredentials } from '../../types'
import { mcpErrorResponse, mcpTextResponse, withMcpErrorHandling } from './mcp-response'

/** SQL文を検証する。writePermissions で INSERT/UPDATE/DELETE の許可を制御 */
export function validateSql(
  sql: string,
  writePermissions?: { insert: boolean; update: boolean; delete: boolean },
): { valid: boolean; error?: string } {
  const trimmed = sql.trim()
  if (!trimmed) {
    return { valid: false, error: 'SQL query is empty' }
  }

  const upper = trimmed.toUpperCase()

  // DDLは常に禁止
  const ddlKeywords = ['DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE', 'UNION']
  for (const keyword of ddlKeywords) {
    const regex = new RegExp(`(?<![A-Z_])${keyword}(?![A-Z_])`)
    if (regex.test(upper)) {
      return { valid: false, error: `Forbidden SQL operation: ${keyword}` }
    }
  }

  // DML書き込み操作は writePermissions に基づいて許可/拒否
  const dmlChecks: Array<{ keyword: string; permission: boolean }> = [
    { keyword: 'INSERT', permission: writePermissions?.insert === true },
    { keyword: 'UPDATE', permission: writePermissions?.update === true },
    { keyword: 'DELETE', permission: writePermissions?.delete === true },
  ]
  for (const { keyword, permission } of dmlChecks) {
    const regex = new RegExp(`(?<![A-Z_])${keyword}(?![A-Z_])`)
    if (regex.test(upper) && !permission) {
      return { valid: false, error: `Forbidden SQL operation: ${keyword}` }
    }
  }

  // 許可される先頭キーワード
  const allowedStarts = ['SELECT', 'WITH', 'EXPLAIN']
  if (writePermissions?.insert) allowedStarts.push('INSERT')
  if (writePermissions?.update) allowedStarts.push('UPDATE')
  if (writePermissions?.delete) allowedStarts.push('DELETE')

  const startsWithAllowed = allowedStarts.some((kw) => upper.startsWith(kw))
  if (!startsWithAllowed) {
    const allowed = allowedStarts.join(', ')
    return { valid: false, error: `Only ${allowed} statements are allowed` }
  }

  return { valid: true }
}

/** DB接続を作成してクエリを実行する */
export async function executeQuery(
  credentials: DbCredentials,
  sql: string,
): Promise<unknown[]> {
  if (credentials.engine === 'mysql') {
    const mysql2 = await import('mysql2/promise')
    const connection = await mysql2.createConnection({
      host: credentials.host,
      port: credentials.port,
      user: credentials.user,
      password: credentials.password,
      database: credentials.database,
      connectTimeout: 10000,
    })
    try {
      const [rows] = await connection.query(sql)
      return rows as unknown[]
    } finally {
      await connection.end()
    }
  }

  if (credentials.engine === 'postgresql') {
    const { Client } = await import('pg')
    const isLocalHost = credentials.host === 'localhost' || credentials.host === '127.0.0.1'
    const useSsl = credentials.ssl !== undefined ? credentials.ssl : !isLocalHost
    const client = new Client({
      host: credentials.host,
      port: credentials.port,
      user: credentials.user,
      password: credentials.password,
      database: credentials.database,
      connectionTimeoutMillis: 10000,
      ssl: useSsl ? { rejectUnauthorized: true } : false,
    })
    try {
      await client.connect()
      const result = await client.query(sql)
      return result.rows
    } finally {
      await client.end()
    }
  }

  throw new Error(`Unsupported database engine: ${credentials.engine}`)
}

/** db_query ツールを MCP サーバーに登録する */
export function registerDbQueryTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'db_query',
    'Execute a SQL query on a project database. Supports SELECT, INSERT, UPDATE, and DELETE. Write operations (INSERT/UPDATE/DELETE) are allowed when the database connection has the corresponding write permissions configured. DDL operations are always forbidden. Submit the SQL directly — permission checks are handled server-side.',
    {
      name: z.string().describe('Database connection name (e.g. "MAIN", "READONLY")'),
      sql: z.string().describe('SQL query to execute (SELECT, INSERT, UPDATE, DELETE)'),
    },
    async ({ name, sql }) => withMcpErrorHandling(async () => {
      // Get credentials from API (includes writePermissions)
      const credentials = await apiClient.getDbCredentials(name)

      // Validate SQL with write permissions
      const validation = validateSql(sql, credentials.writePermissions)
      if (!validation.valid) {
        return mcpErrorResponse(validation.error!)
      }

      // Execute query
      const rows = await executeQuery(credentials, sql)

      // Format result
      return mcpTextResponse(JSON.stringify(rows, null, 2))
    }),
  )
}
