import { ApiClient } from '../api-client'
import { type AwsCredentialResult, buildAwsProfileCredentials, buildSingleAccountAwsEnv } from '../aws-credential-builder'
import { ERR_AGENT_ID_REQUIRED, ERR_MESSAGE_REQUIRED, LOG_MESSAGE_LIMIT } from '../constants'
import { logger } from '../logger'
import { type AgentChatMode, type AgentServerConfig, type ChatChunkType, type ChatPayload, type CommandResult, errorResult, type ProjectConfigResponse, successResult } from '../types'
import { parseString, truncateString } from '../utils'

import { getAutoAddDirs } from '../project-dir'
import { executeApiChatCommand } from './api-chat-executor'
import { runClaudeCode } from './claude-code-runner'
import { downloadChatFiles, parseChatFiles } from './file-transfer'
import { createChunkSender, formatHistoryForClaudeCode, handleChatError, parseHistory } from './shared-chat-utils'

// Re-export for backward compatibility with existing consumers
export { buildClaudeArgs, buildCleanEnv, _resetCleanEnvCache } from './claude-code-runner'

/** 実行中のチャットプロセスを commandId で管理 */
const runningProcesses = new Map<string, { cancel: () => void }>()

/**
 * 実行中のチャットプロセスをキャンセルする
 * @returns true: プロセスが見つかりキルした, false: プロセスが見つからなかった
 */
export function cancelChatProcess(commandId: string): boolean {
  const handle = runningProcesses.get(commandId)
  if (handle) {
    handle.cancel()
    runningProcesses.delete(commandId)
    return true
  }
  return false
}

/** テスト用: runningProcesses の内容を取得 */
export function _getRunningProcesses(): Map<string, { cancel: () => void }> {
  return runningProcesses
}

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
    return errorResult(ERR_AGENT_ID_REQUIRED)
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
    return errorResult(ERR_MESSAGE_REQUIRED)
  }

  logger.info(`[chat] Starting chat command [${commandId}]: message="${truncateString(message, LOG_MESSAGE_LIMIT)}"`)

  const { sendChunk, getChunkIndex } = createChunkSender(commandId, client, agentId, 'chat', { debugLog: true })

  try {
    const allowedTools = serverConfig?.claudeCodeConfig?.allowedTools
    const systemPrompt = serverConfig?.claudeCodeConfig?.systemPrompt
    const serverAddDirs = serverConfig?.claudeCodeConfig?.addDirs ?? []
    // Merge project directory auto-add dirs with server-configured dirs
    let addDirs: string[] | undefined
    if (projectDir) {
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
      await sendAwsCredentialNotices(awsResult, projectCode, sendChunk)
    } else {
      // フォールバック: 単一アカウントの環境変数直接注入（従来方式）
      const awsAccountId = parseString(payload.awsAccountId) ?? undefined
      const awsResult = await buildSingleAccountAwsEnv(client, awsAccountId)
      awsEnv = awsResult.env
      await sendAwsCredentialNotices(awsResult, projectCode, sendChunk)
    }

    // 添付ファイルのダウンロード
    const chatFiles = parseChatFiles(payload.files)
    const conversationId = parseString(payload.conversationId)
    let filePathsNotice = ''
    let cleanupDownloads: (() => void) | undefined
    if (chatFiles.length > 0 && projectDir && conversationId) {
      const downloadResult = await downloadChatFiles(client, agentId, chatFiles, projectDir, conversationId)
      cleanupDownloads = downloadResult.cleanup
      if (downloadResult.downloadedPaths.length > 0) {
        filePathsNotice = `\n\n<attached_files>\n${downloadResult.downloadedPaths.map((p) => `- ${p}`).join('\n')}\n</attached_files>`
        logger.info(`[chat] Downloaded ${downloadResult.downloadedPaths.length} files for command [${commandId}]`)
      }
      if (downloadResult.failedCount > 0) {
        await sendChunk('delta', `⚠️ ${downloadResult.failedCount}件のファイルのダウンロードに失敗しました\n\n`)
      }
    }

    // 会話履歴をメッセージに埋め込む（Claude Code CLI用）
    const history = parseHistory(payload.history)

    // file_upload ツールに必要なメタデータをメッセージに付加
    let metadataNotice = ''
    if (conversationId && mcpConfigPath) {
      metadataNotice = `\n\n<message_metadata>\nconversationId: ${conversationId}\nmessageId: ${commandId}\nprojectCode: ${projectCode ?? ''}\n</message_metadata>`
    }

    const messageWithHistory = formatHistoryForClaudeCode(history, message + filePathsNotice + metadataNotice)

    const logDetails = [
      allowedTools?.length ? `allowedTools: ${allowedTools.join(', ')}` : '(no allowedTools)',
      addDirs?.length ? `addDirs: ${addDirs.join(', ')}` : null,
      locale ? `locale=${locale}` : null,
      awsEnv ? 'AWS credentials' : null,
      mcpConfigPath ? 'MCP config' : null,
      history.length > 0 ? `${history.length} history messages` : null,
      chatFiles.length > 0 ? `${chatFiles.length} attached files` : null,
    ].filter(Boolean).join(', ')
    logger.debug(`[chat] Spawning claude CLI for command [${commandId}]: ${logDetails}`)
    logger.debug(`[chat] serverConfig.claudeCodeConfig: ${JSON.stringify(serverConfig?.claudeCodeConfig ?? null)}`)
    const handle = runClaudeCode({
      message: messageWithHistory,
      sendChunk,
      allowedTools,
      addDirs,
      locale,
      awsEnv,
      mcpConfigPath,
      cwd: projectDir,
      systemPrompt,
    })
    // プロセスを管理 Map に登録
    runningProcesses.set(commandId, handle)
    let result
    try {
      result = await handle.result
    } finally {
      runningProcesses.delete(commandId)
    }
    logger.info(`[chat] Chat command completed [${commandId}]: output=${result.text.length} chars, ${getChunkIndex()} chunks sent, duration=${result.metadata.durationMs}ms`)
    // 完了チャンクを送信（metadata を含める）
    const doneContent = JSON.stringify({
      text: result.text,
      metadata: result.metadata,
    })
    await sendChunk('done', doneContent)

    // ダウンロードした一時ファイルをクリーンアップ
    cleanupDownloads?.()

    return successResult(result.text)
  } catch (error) {
    return handleChatError(error, commandId, 'chat', sendChunk)
  }
}

async function sendAwsCredentialNotices(
  awsResult: AwsCredentialResult,
  projectCode: string | undefined,
  sendChunk: (type: ChatChunkType, content: string) => Promise<void>,
): Promise<void> {
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
