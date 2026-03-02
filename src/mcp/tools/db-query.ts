import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import type { DbCredentials } from '../../types'
import { extractErrorMessage, mcpErrorResponse, mcpTextResponse } from './mcp-response'

/** SQL文が SELECT のみかどうか検証する */
export function validateSelectOnly(sql: string): { valid: boolean; error?: string } {
  const trimmed = sql.trim()
  if (!trimmed) {
    return { valid: false, error: 'SQL query is empty' }
  }

  // 禁止キーワードをチェック（大文字小文字無視）
  const forbidden = ['DROP', 'DELETE', 'UPDATE', 'INSERT', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE']
  const upper = trimmed.toUpperCase()
  for (const keyword of forbidden) {
    // 単語境界でマッチ（前後が非単語文字 or 文字列の先頭/末尾）
    const regex = new RegExp(`(?<![A-Z_])${keyword}(?![A-Z_])`)
    if (regex.test(upper)) {
      return { valid: false, error: `Forbidden SQL operation: ${keyword}` }
    }
  }

  // SELECT で始まることを確認（WITH ... SELECT も許可）
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH') && !upper.startsWith('EXPLAIN')) {
    return { valid: false, error: 'Only SELECT, WITH, and EXPLAIN statements are allowed' }
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
    'Execute a SELECT query on a project database. Only SELECT/WITH/EXPLAIN statements are allowed.',
    {
      name: z.string().describe('Database connection name (e.g. "MAIN", "READONLY")'),
      sql: z.string().describe('SQL query to execute (SELECT only)'),
    },
    async ({ name, sql }) => {
      // Validate SQL
      const validation = validateSelectOnly(sql)
      if (!validation.valid) {
        return mcpErrorResponse(validation.error!)
      }

      try {
        // Get credentials from API
        const credentials = await apiClient.getDbCredentials(name)

        // Execute query
        const rows = await executeQuery(credentials, sql)

        // Format result
        return mcpTextResponse(JSON.stringify(rows, null, 2))
      } catch (error) {
        return mcpErrorResponse(extractErrorMessage(error))
      }
    },
  )
}
