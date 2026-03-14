import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import type { DbCredentials } from '../../types'
import { mcpErrorResponse, mcpTextResponse, withMcpErrorHandling } from './mcp-response'

/** コメントインジェクション検出パターン */
const COMMENT_PATTERNS = ['--', '/*', '*/', '#']

/** 時間ベース・ブラインドSQLインジェクション検出パターン */
const TIME_BASED_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bDBMS_LOCK\.SLEEP\s*\(/i, name: 'DBMS_LOCK.SLEEP' },
  { pattern: /\bPG_SLEEP\s*\(/i, name: 'PG_SLEEP' },
  { pattern: /\bSLEEP\s*\(/i, name: 'SLEEP' },
  { pattern: /\bBENCHMARK\s*\(/i, name: 'BENCHMARK' },
  { pattern: /\bWAITFOR\s+DELAY\b/i, name: 'WAITFOR DELAY' },
]

/** エンコーディングバイパス検出パターン */
const ENCODING_BYPASS_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\b0x[0-9a-fA-F]+\b/, name: 'hex literal' },
  { pattern: /\bCONVERT\s*\(/i, name: 'CONVERT' },
  { pattern: /\bUNHEX\s*\(/i, name: 'UNHEX' },
]

/** ファイルシステム・システムアクセス検出パターン */
const FILE_SYSTEM_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bLOAD\s+DATA\b/i, name: 'LOAD DATA' },
  { pattern: /\bINTO\s+OUTFILE\b/i, name: 'INTO OUTFILE' },
  { pattern: /\bINTO\s+DUMPFILE\b/i, name: 'INTO DUMPFILE' },
  { pattern: /\bxp_cmdshell\b/i, name: 'xp_cmdshell' },
  { pattern: /\bxp_regread\b/i, name: 'xp_regread' },
  { pattern: /\bsp_executesql\b/i, name: 'sp_executesql' },
]

/** サブクエリ最大ネスト深度 */
const MAX_SUBQUERY_DEPTH = 3

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

  // コメントインジェクション検出（最優先）
  for (const pattern of COMMENT_PATTERNS) {
    if (trimmed.includes(pattern)) {
      return { valid: false, error: 'SQL comments are not allowed' }
    }
  }

  // 複数ステートメント検出（末尾セミコロンは許可）
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '')
  if (withoutTrailingSemicolon.includes(';')) {
    return { valid: false, error: 'Multiple SQL statements are not allowed' }
  }

  // DDLは常に禁止（EXEC/EXECUTE追加）
  const ddlKeywords = ['DROP', 'TRUNCATE', 'ALTER', 'CREATE', 'GRANT', 'REVOKE', 'UNION', 'EXEC', 'EXECUTE']
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

  // 時間ベース・ブラインドSQLインジェクション検出
  for (const { pattern, name } of TIME_BASED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, error: `Dangerous function detected: ${name}` }
    }
  }

  // エンコーディングバイパス検出
  for (const { pattern, name } of ENCODING_BYPASS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, error: `Encoding bypass detected: ${name}` }
    }
  }

  // ファイルシステム・システムアクセス検出
  for (const { pattern, name } of FILE_SYSTEM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { valid: false, error: `Dangerous operation detected: ${name}` }
    }
  }

  // サブクエリ深度制限
  const selectCount = (upper.match(/\bSELECT\b/g) || []).length
  if (selectCount > MAX_SUBQUERY_DEPTH + 1) {
    return { valid: false, error: `Subquery nesting too deep (max ${MAX_SUBQUERY_DEPTH} levels)` }
  }

  // 許可される先頭キーワード（SHOW/DESCRIBE追加）
  const allowedStarts = ['SELECT', 'WITH', 'EXPLAIN', 'SHOW', 'DESCRIBE', 'DESC']
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
