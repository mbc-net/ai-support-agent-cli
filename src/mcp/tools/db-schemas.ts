import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { executeQuery } from './db-query'
import { extractErrorMessage, mcpErrorResponse, mcpTextResponse } from './mcp-response'

const MYSQL_SCHEMA_QUERY = `
SELECT
  TABLE_NAME,
  COLUMN_NAME,
  DATA_TYPE,
  IS_NULLABLE,
  COLUMN_KEY,
  COLUMN_DEFAULT,
  EXTRA
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
ORDER BY TABLE_NAME, ORDINAL_POSITION
`

const PG_SCHEMA_QUERY = `
SELECT
  c.table_name,
  c.column_name,
  c.data_type,
  c.is_nullable,
  CASE
    WHEN tc.constraint_type = 'PRIMARY KEY' THEN 'PRI'
    WHEN tc.constraint_type = 'UNIQUE' THEN 'UNI'
    ELSE ''
  END AS column_key,
  c.column_default
FROM information_schema.columns c
LEFT JOIN information_schema.key_column_usage kcu
  ON c.table_name = kcu.table_name
  AND c.column_name = kcu.column_name
  AND c.table_schema = kcu.table_schema
LEFT JOIN information_schema.table_constraints tc
  ON kcu.constraint_name = tc.constraint_name
  AND kcu.table_schema = tc.table_schema
WHERE c.table_schema = 'public'
ORDER BY c.table_name, c.ordinal_position
`

/** get_db_schemas ツールを MCP サーバーに登録する */
export function registerDbSchemasTool(server: McpServer, apiClient: ApiClient): void {
  server.tool(
    'get_db_schemas',
    'Get the schema (tables and columns) of a project database.',
    {
      name: z.string().describe('Database connection name (e.g. "MAIN", "READONLY")'),
    },
    async ({ name }) => {
      try {
        const credentials = await apiClient.getDbCredentials(name)

        const query = credentials.engine === 'mysql'
          ? MYSQL_SCHEMA_QUERY
          : PG_SCHEMA_QUERY

        const rows = await executeQuery(credentials, query)

        return mcpTextResponse(JSON.stringify(rows, null, 2))
      } catch (error) {
        return mcpErrorResponse(extractErrorMessage(error))
      }
    },
  )
}
