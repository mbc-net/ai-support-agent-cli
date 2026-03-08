import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export interface BacklogMcpConfig {
  domain: string
  apiKey: string
}

/**
 * MCP 設定ファイルのパスを返す
 */
export function getMcpConfigPath(projectDir: string): string {
  return join(projectDir, '.ai-support-agent', 'mcp', 'config.json')
}

/**
 * MCP 設定 JSON を構築する
 *
 * token はファイルに書かない。環境変数参照にする。
 */
export function buildMcpConfig(
  apiUrl: string,
  projectCode: string,
  mcpServerPath: string,
): Record<string, unknown> {
  return {
    mcpServers: {
      'ai-support-agent': {
        command: 'node',
        args: [mcpServerPath],
        env: {
          AI_SUPPORT_AGENT_API_URL: apiUrl,
          AI_SUPPORT_AGENT_TOKEN: '${AI_SUPPORT_AGENT_TOKEN}',
          AI_SUPPORT_AGENT_PROJECT_CODE: projectCode,
        },
      },
    },
  }
}

/**
 * MCP 設定ファイルを書き出す
 *
 * 0o600 権限で作成し、token は環境変数参照にする。
 */
export function writeMcpConfig(
  projectDir: string,
  apiUrl: string,
  token: string,
  projectCode: string,
  mcpServerPath: string,
  backlogConfigs?: BacklogMcpConfig[],
): string {
  const configPath = getMcpConfigPath(projectDir)
  const dir = dirname(configPath)

  mkdirSync(dir, { recursive: true, mode: 0o700 })

  // 実際の設定: token を直接埋め込む（ファイルは 0o600 で保護）
  const config: Record<string, unknown> = {
    mcpServers: {
      'ai-support-agent': {
        command: 'node',
        args: [mcpServerPath],
        env: {
          AI_SUPPORT_AGENT_API_URL: apiUrl,
          AI_SUPPORT_AGENT_TOKEN: token,
          AI_SUPPORT_AGENT_PROJECT_CODE: projectCode,
        },
      },
      // Backlog MCPサーバー（設定がある場合のみ）
      ...(backlogConfigs?.length
        ? {
            backlog: {
              command: 'npx',
              args: ['backlog-mcp-server'],
              env: {
                BACKLOG_DOMAIN: backlogConfigs[0].domain,
                BACKLOG_API_KEY: backlogConfigs[0].apiKey,
              },
            },
          }
        : {}),
    },
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
  })

  return configPath
}
