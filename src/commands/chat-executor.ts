import { ApiClient } from '../api-client'
import { buildAwsProfileCredentials, buildSingleAccountAwsEnv } from '../aws-credential-builder'
import { ERR_AGENT_ID_REQUIRED, ERR_MESSAGE_REQUIRED, LOG_MESSAGE_LIMIT } from '../constants'
import { logger } from '../logger'
import type { AgentChatMode, AgentServerConfig, ChatPayload, CommandResult, ProjectConfigResponse } from '../types'
import { getErrorMessage, parseString, truncateString } from '../utils'

import { executeApiChatCommand } from './api-chat-executor'
import { runClaudeCode } from './claude-code-runner'
import { createChunkSender, formatHistoryForClaudeCode, parseHistory } from './shared-chat-utils'

// Re-export for backward compatibility with existing consumers
export { buildClaudeArgs, buildCleanEnv } from './claude-code-runner'

/**
 * エージェントチャットモードに応じてチャットメッセージを処理する
 * - claude_code: Claude Code CLI を使用（デフォルト）
 * - api: Anthropic API 直接呼び出し
 *
 * activeChatMode はサーバーの chatMode ではなく、エージェント内部の実行方式を指す
 */
export async function executeChatCommand(
  payload: ChatPayload,
  commandId: string,
  client: ApiClient,
  serverConfig?: AgentServerConfig,
  activeChatMode?: AgentChatMode,
  agentId?: string,
  projectDir?: string,
  projectConfig?: ProjectConfigResponse,
  mcpConfigPath?: string,
): Promise<CommandResult> {
  if (!agentId) {
    return { success: false, error: ERR_AGENT_ID_REQUIRED }
  }

  const mode = activeChatMode ?? 'claude_code'

  switch (mode) {
    case 'api':
      return executeApiChatCommand(payload, commandId, client, serverConfig, agentId)
    case 'claude_code':
    default:
      return executeClaudeCodeChat(payload, commandId, client, agentId, serverConfig, projectDir, projectConfig, mcpConfigPath)
  }
}

/**
 * Claude Code CLI を使用してチャットメッセージを処理する
 * サブプロセスとして起動し、stdout をストリーミングで読み取り、
 * チャンクとしてAPIに送信する
 */
async function executeClaudeCodeChat(
  payload: ChatPayload,
  commandId: string,
  client: ApiClient,
  agentId: string,
  serverConfig?: AgentServerConfig,
  projectDir?: string,
  projectConfig?: ProjectConfigResponse,
  mcpConfigPath?: string,
): Promise<CommandResult> {
  const message = parseString(payload.message)
  if (!message) {
    return { success: false, error: ERR_MESSAGE_REQUIRED }
  }

  logger.info(`[chat] Starting chat command [${commandId}]: message="${truncateString(message, LOG_MESSAGE_LIMIT)}"`)

  const { sendChunk, getChunkIndex } = createChunkSender(commandId, client, agentId, 'chat', { debugLog: true })

  try {
    const allowedTools = serverConfig?.claudeCodeConfig?.allowedTools
    const serverAddDirs = serverConfig?.claudeCodeConfig?.addDirs ?? []
    // Merge project directory auto-add dirs with server-configured dirs
    let addDirs: string[] | undefined
    if (projectDir) {
      const { getAutoAddDirs } = await import('../project-dir')
      const autoAddDirs = getAutoAddDirs(projectDir)
      addDirs = [...autoAddDirs, ...serverAddDirs]
    } else {
      addDirs = serverAddDirs.length > 0 ? serverAddDirs : undefined
    }
    const locale = parseString(payload.locale) ?? undefined

    // AWS認証情報を取得（プロファイル方式 or 環境変数直接注入）
    let awsEnv: Record<string, string> | undefined
    const projectCode = parseString(payload.projectCode) ?? projectConfig?.project.projectCode
    if (projectDir && projectConfig?.aws?.accounts?.length) {
      // プロファイル方式: 全アカウントの認証情報を取得してプロファイルファイルに書き込み
      const awsResult = await buildAwsProfileCredentials(client, projectDir, projectConfig)
      awsEnv = awsResult.env
      if (awsResult.errors.length > 0) {
        const notice = `⚠️ ${awsResult.errors.join('\n')}\n\n`
        await sendChunk('delta', notice)
      }
      // SSO再認証が必要なアカウントの情報を system チャンクで送信
      for (const ssoInfo of awsResult.ssoAuthRequired) {
        await sendChunk('system', JSON.stringify({
          type: 'sso_auth_required',
          accountId: ssoInfo.accountId,
          accountName: ssoInfo.accountName,
          projectCode,
        }))
      }
    } else {
      // フォールバック: 単一アカウントの環境変数直接注入（従来方式）
      const awsAccountId = parseString(payload.awsAccountId) ?? undefined
      const awsResult = await buildSingleAccountAwsEnv(client, awsAccountId)
      awsEnv = awsResult.env
      if (awsResult.errors.length > 0) {
        const notice = `⚠️ ${awsResult.errors.join('\n')}\n\n`
        await sendChunk('delta', notice)
      }
      // SSO再認証が必要なアカウントの情報を system チャンクで送信
      for (const ssoInfo of awsResult.ssoAuthRequired) {
        await sendChunk('system', JSON.stringify({
          type: 'sso_auth_required',
          accountId: ssoInfo.accountId,
          accountName: ssoInfo.accountName,
          projectCode,
        }))
      }
    }

    // 会話履歴をメッセージに埋め込む（Claude Code CLI用）
    const history = parseHistory(payload.history)
    const messageWithHistory = formatHistoryForClaudeCode(history, message)

    logger.debug(`[chat] Spawning claude CLI for command [${commandId}]${allowedTools?.length ? ` with allowedTools: ${allowedTools.join(', ')}` : ' (no allowedTools)'}${addDirs?.length ? ` with addDirs: ${addDirs.join(', ')}` : ''}${locale ? ` locale=${locale}` : ''}${awsEnv ? ' with AWS credentials' : ''}${mcpConfigPath ? ' with MCP config' : ''}${history.length > 0 ? ` with ${history.length} history messages` : ''}`)
    logger.debug(`[chat] serverConfig.claudeCodeConfig: ${JSON.stringify(serverConfig?.claudeCodeConfig ?? null)}`)
    const result = await runClaudeCode(messageWithHistory, sendChunk, allowedTools, addDirs, locale, awsEnv, mcpConfigPath)
    logger.info(`[chat] Chat command completed [${commandId}]: output=${result.text.length} chars, ${getChunkIndex()} chunks sent, duration=${result.metadata.durationMs}ms`)
    // 完了チャンクを送信（metadata を含める）
    const doneContent = JSON.stringify({
      text: result.text,
      metadata: result.metadata,
    })
    await sendChunk('done', doneContent)
    return { success: true, data: result.text }
  } catch (error) {
    const errorMessage = getErrorMessage(error)
    logger.error(`[chat] Chat command failed [${commandId}]: ${errorMessage}`)
    await sendChunk('error', errorMessage)
    return { success: false, error: errorMessage }
  }
}
