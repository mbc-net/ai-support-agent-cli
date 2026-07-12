import { randomUUID } from 'crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { logger } from '../logger'
import { getErrorMessage } from '../utils'

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
  tenantCode: string,
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
          AI_SUPPORT_AGENT_TENANT_CODE: tenantCode,
        },
      },
    },
  }
}

/**
 * ブラウザローカルポートの環境変数名
 */
export const BROWSER_LOCAL_PORT_ENV = 'AI_SUPPORT_BROWSER_LOCAL_PORT'

/**
 * 実際のSlackチャット会話ID（conversationId）の環境変数名。
 *
 * read_slack_thread MCPツールが子プロセス（Claude Code CLI がさらに spawn する
 * MCP サーバー）側で `process.env[CONVERSATION_ID_ENV]` として読み取り、現在処理中の
 * Slackスレッドを逆引きするために使用する。
 *
 * 注意: `@modelcontextprotocol/sdk` の `StdioClientTransport` は MCP サーバー子プロセスへ
 * `{ ...getDefaultEnvironment(), ...serverParams.env }` のみを渡す実装になっており、
 * `getDefaultEnvironment()` は HOME/LOGNAME/PATH/SHELL/TERM/USER（Windows: APPDATA 等）
 * のみを継承する。つまり呼び出し元プロセス（claude/codex CLI）が任意に持つ
 * `process.env.AI_SUPPORT_CONVERSATION_ID` は MCP サーバー子プロセスへは自動継承されず、
 * MCP 設定ファイルの `env` に明示的に含まれている場合のみ子プロセスに渡る
 * （`node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js` で確認済み）。
 * このため conversationId は `writeMcpConfig` が書くプロジェクト単位の静的ファイルではなく、
 * チャットコマンド単位で `writeCommandMcpConfig` が書く per-command ファイルの `env` に
 * 明示的に埋め込む必要がある。
 */
export const CONVERSATION_ID_ENV = 'AI_SUPPORT_CONVERSATION_ID'

/**
 * 実行中タスクのIDの環境変数名。
 *
 * `trigger_e2e_test` MCPツールが子プロセス側で `process.env[TASK_ID_ENV]` として
 * 読み取り、起動したE2E実行をこのタスクに紐付ける（タスク詳細画面のE2Eテストタブ
 * からの逆引き用）。`CONVERSATION_ID_ENV` と同じ理由（`StdioClientTransport` が
 * 呼び出し元プロセスの任意の環境変数をMCPサーバー子プロセスへ自動継承しない）により、
 * `writeCommandMcpConfig` が書く per-command ファイルの `env` に明示的に埋め込む
 * 必要がある。
 */
export const TASK_ID_ENV = 'AI_SUPPORT_TASK_ID'

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
  tenantCode?: string,
  browserLocalPort?: number,
): string {
  const configPath = getMcpConfigPath(projectDir)
  const dir = dirname(configPath)

  mkdirSync(dir, { recursive: true, mode: 0o700 })

  // Parse tenantCode from token if not provided: {tenantCode}:{tokenId}:{rawToken}
  const resolvedTenantCode = tenantCode ?? (() => {
    const parts = token.split(':')
    return parts.length >= 3 ? parts[0] : ''
  })()

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
          AI_SUPPORT_AGENT_TENANT_CODE: resolvedTenantCode,
          ...(browserLocalPort && {
            [BROWSER_LOCAL_PORT_ENV]: String(browserLocalPort),
          }),
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

interface McpServerEntry {
  command?: unknown
  args?: unknown
  env?: Record<string, unknown>
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>
}

/**
 * commandId をファイル名に安全に埋め込めるよう、英数字・アンダースコア・ハイフン
 * 以外の文字を `_` に置換する（パストラバーサル対策）。
 */
function sanitizeCommandIdForFilename(commandId: string): string {
  return commandId.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * チャットコマンド（Slackメッセージ）単位の MCP 設定ファイルを書き出す。
 *
 * `writeMcpConfig` が書く `.ai-support-agent/mcp/config.json` はプロジェクト単位の
 * 静的ファイルで、config sync 時にのみ再生成され、複数のチャットコマンド（複数の
 * Slack会話が並行/連続実行される場合を含む）から共有される。conversationId は
 * コマンド単位で変わる値であり、この静的ファイルに書き込むと「別会話の
 * conversationId が残ったまま次のコマンドに使われる」「並行実行時に競合する」
 * リスクがある（`agent-transport.ts` の `void handleNotification(...)` により、
 * 同一エージェントが複数コマンドを並行処理しうるため）。
 *
 * そのため、`ai-support-agent` サーバーの `env` に conversationId を埋め込んだ
 * コマンド専用の設定ファイルを都度書き出す。呼び出し元はコマンド完了後に
 * このファイルを削除すること。
 *
 * ファイル名には commandId（サニタイズ済み、デバッグ用）に加えて `randomUUID()` を
 * 必ず含める。commandId は外部API由来で形式保証がなく、サニタイズ後に別の commandId
 * と衝突しうる（例: `cmd/a` と `cmd_a` はいずれも `cmd_a` に正規化される）。UUID を
 * 含めないと、並行実行中の別コマンドの設定ファイルを誤って参照・削除してしまい、
 * conversationId の混線やMCPサーバー起動失敗を招く。書き込みは排他生成（`wx` フラグ）
 * で行い、万一の衝突は例外として検知する（呼び出し元は失敗時に共有静的設定へ
 * フォールバックする設計になっている）。
 *
 * `read_slack_thread` ツールが子プロセス側で `process.env[CONVERSATION_ID_ENV]` として
 * 読み取れるのは、MCP サーバー子プロセスへは `StdioClientTransport` 経由で
 * 設定ファイルの `env` に明示されたキーのみが渡され、呼び出し元プロセス
 * （claude/codex CLI）の任意の環境変数は自動継承されないため（`CONVERSATION_ID_ENV`
 * の定義コメント参照）。
 */
export function writeCommandMcpConfig(
  baseConfigPath: string,
  commandId: string,
  conversationId: string,
  taskId?: string,
): string {
  const raw = readFileSync(baseConfigPath, 'utf-8')
  const config = JSON.parse(raw) as McpConfigFile

  const server = config.mcpServers?.['ai-support-agent']
  if (server) {
    server.env = {
      ...(server.env ?? {}),
      [CONVERSATION_ID_ENV]: conversationId,
      ...(taskId && { [TASK_ID_ENV]: taskId }),
    }
  }

  const dir = dirname(baseConfigPath)
  const commandConfigPath = join(
    dir,
    `config-${sanitizeCommandIdForFilename(commandId)}-${randomUUID()}.json`,
  )

  writeFileSync(commandConfigPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
    // 排他生成: 同名ファイルが既に存在する場合は例外を投げる（UUID衝突の理論上の
    // 可能性・命名ロジックのバグを検知するための多層防御）。
    flag: 'wx',
  })

  return commandConfigPath
}

/**
 * 孤立した per-command MCP 設定ファイル（`config-*.json`）を一括削除する。
 *
 * 通常はコマンド完了時（chat-executor.ts の cleanupCommandMcpConfig）に削除されるが、
 * エージェント process が SIGKILL / OOM 等で異常終了した場合、平文トークンと
 * conversationId を含む孤立ファイルが `.ai-support-agent/mcp/` に残り続ける。
 * `TerminalSession.cleanupStaleSandboxes` と同じパターンで、一定時間以上前のものを
 * 掃除する。共有静的ファイル（`config.json` 自体、`baseConfigPath` の basename）や
 * 無関係なファイルには触れない。
 *
 * @param baseConfigPath `getMcpConfigPath(projectDir)` が返す静的設定ファイルのパス
 * @param maxAgeMs 削除対象とする経過時間 (ms)。デフォルト 24 時間。0 で全削除
 * @returns 削除した件数
 */
export function cleanupStaleCommandMcpConfigs(
  baseConfigPath: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): number {
  const dir = dirname(baseConfigPath)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return 0
  }

  const now = Date.now()
  let removed = 0
  for (const name of entries) {
    if (!name.startsWith('config-') || !name.endsWith('.json')) continue
    const fullPath = join(dir, name)
    try {
      const stat = statSync(fullPath)
      if (maxAgeMs > 0 && now - stat.mtimeMs < maxAgeMs) continue
      rmSync(fullPath, { force: true })
      removed++
    } catch (error) {
      // 個々のファイル失敗で掃除全体を止めないが、無音のまま握り潰さず記録する
      // （どのファイルが掃除されなかったか運用上追跡できるようにする）。
      logger.warn(`[mcp-config] Failed to clean up stale per-command MCP config ${name}: ${getErrorMessage(error)}`)
    }
  }
  return removed
}

