import { ApiClient } from '../api-client'
import { type AwsCredentialResult, buildAwsProfileCredentials, buildSingleAccountAwsEnv } from '../aws-credential-builder'
import { ERR_AGENT_ID_REQUIRED, ERR_MESSAGE_REQUIRED, LOG_MESSAGE_LIMIT } from '../constants'
import { buildGitCredentialEnv } from '../git-credential-setup'
import { logger } from '../logger'
import { type AgentChatMode, type AgentServerConfig, type ChatChunkType, type ChatFileInfo, type ChatPayload, type CommandResult, errorResult, type ProjectConfigResponse, successResult } from '../types'
import { getErrorMessage, parseString, truncateString } from '../utils'

import { getAutoAddDirs, getWorkspaceDir } from '../project-dir'
import { ensureAllowedToolsInSettings } from '../utils/claude-settings'
import { executeApiChatCommand } from './api-chat-executor'
import { runClaudeCode } from './claude-code-runner'
import { downloadChatFiles, parseChatFiles, parseConversationFiles } from './file-transfer'
import { cancelProcess, getProcessManager, _getRunningProcesses as _getRunningFromManager } from './process-manager'
import { createChunkSender, formatHistoryForClaudeCode, handleChatError, parseHistory, sendDoneChunk } from './shared-chat-utils'

// Re-export for backward compatibility with existing consumers
export { buildClaudeArgs, buildCleanEnv, _resetCleanEnvCache } from './claude-code-runner'

/** 実行中のチャットプロセスを commandId で管理 */
const processManager = getProcessManager()

/**
 * 実行中のチャットプロセスをキャンセルする
 * @deprecated Use {@link cancelProcess} from './process-manager' instead.
 * Both chat-executor and api-chat-executor share the same ProcessManager singleton.
 * @returns true: プロセスが見つかりキルした, false: プロセスが見つからなかった
 */
export function cancelChatProcess(commandId: string): boolean {
  return cancelProcess(commandId)
}

/**
 * テスト用: runningProcesses の内容を取得
 * @deprecated Use {@link _getRunningProcesses} from './process-manager' instead.
 */
export function _getRunningProcesses(): Map<string, { cancel: () => void }> {
  return _getRunningFromManager()
}

/** Options for executeChatCommand */
export interface ExecuteChatCommandOptions {
  payload: ChatPayload
  commandId: string
  client: ApiClient
  serverConfig?: AgentServerConfig
  activeChatMode?: AgentChatMode
  agentId?: string
  projectDir?: string
  projectConfig?: ProjectConfigResponse
  mcpConfigPath?: string
  tenantCode?: string
}

/**
 * エージェントチャットモードに応じてチャットメッセージを処理する
 * - claude_code: Claude Code CLI を使用（デフォルト）
 * - api: Anthropic API 直接呼び出し
 *
 * activeChatMode はサーバーの chatMode ではなく、エージェント内部の実行方式を指す
 */
export async function executeChatCommand(options: ExecuteChatCommandOptions): Promise<CommandResult> {
  const {
    payload,
    commandId,
    client,
    serverConfig,
    activeChatMode,
    agentId,
    projectDir,
    projectConfig,
    mcpConfigPath,
    tenantCode,
  } = options

  if (!agentId) {
    return errorResult(ERR_AGENT_ID_REQUIRED)
  }

  const mode = activeChatMode ?? 'claude_code'

  switch (mode) {
    case 'api':
      return executeApiChatCommand(payload, commandId, client, serverConfig, agentId)
    case 'claude_code':
    default:
      return executeClaudeCodeChat(payload, commandId, client, agentId, serverConfig, projectDir, projectConfig, mcpConfigPath, tenantCode)
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
  tenantCode?: string,
): Promise<CommandResult> {
  const message = parseString(payload.message)
  if (!message) {
    return errorResult(ERR_MESSAGE_REQUIRED)
  }

  logger.info(`[chat] Starting chat command [${commandId}]: message="${truncateString(message, LOG_MESSAGE_LIMIT)}"`)

  const { sendChunk: rawSendChunk, getChunkIndex } = createChunkSender(commandId, client, agentId, 'chat', { debugLog: true })

  // tool_call チャンクを蓄積して done チャンクに含める（RDS 永続化用）
  const collectedToolCalls: Record<string, unknown>[] = []
  const sendChunk = async (type: ChatChunkType, content: string): Promise<void> => {
    if (type === 'tool_call') {
      try {
        collectedToolCalls.push(JSON.parse(content))
      } catch (err) {
        logger.warn(`[chat] Failed to parse tool_call JSON: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    // tool_result チャンクの success/output を対応する tool_call エントリにマージ
    if (type === 'tool_result') {
      try {
        const result = JSON.parse(content) as Record<string, unknown>
        const entry = collectedToolCalls.find(
          (tc) => tc.toolName === result.toolName,
        )
        if (entry) {
          entry.success = result.success
          entry.result = result.output
        }
      } catch (err) {
        logger.warn(`[chat] Failed to parse tool_result JSON: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return rawSendChunk(type, content)
  }

  let cleanupDownloads: (() => void) | undefined
  let cleanupGitCredentials: (() => void) | undefined

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
    const projectCode = parseString(payload.projectCode) ?? projectConfig?.project.projectCode
    const { awsEnv, gitEnv, cleanupGitCredentials: gitCleanup } = await buildEnvironmentCredentials(
      payload, client, projectDir, projectConfig, projectCode, sendChunk,
    )
    cleanupGitCredentials = gitCleanup

    // 添付ファイルのダウンロード
    const conversationId = parseString(payload.conversationId)
    const { filePathsNotice, cleanup: dlCleanup } = await downloadAttachments(
      payload, client, agentId, projectDir, conversationId, commandId, sendChunk,
    )
    cleanupDownloads = dlCleanup

    // 会話全体のファイルリファレンスを埋め込み（MCPツール経由で読み取り可能）
    const conversationFiles = parseConversationFiles(payload.conversationFiles)
    const conversationFileNotice = buildConversationFileNotice(conversationFiles)
    if (conversationFiles.length > 0) {
      logger.info(`[chat] ${conversationFiles.length} conversation file references embedded for command [${commandId}]`)
    }

    // 会話履歴をメッセージに埋め込む（Claude Code CLI用）
    const history = parseHistory(payload.history)

    // file_upload ツールに必要なメタデータをメッセージに付加
    const metadataNotice = buildMetadataNotice(conversationId, commandId, projectCode, mcpConfigPath)

    const messageWithHistory = formatHistoryForClaudeCode(history, message + filePathsNotice + conversationFileNotice + metadataNotice)

    // Ensure allowedTools are registered in Claude Code settings.json
    if (allowedTools?.length) {
      ensureAllowedToolsInSettings(allowedTools)
    }

    const logDetails = [
      allowedTools?.length ? `allowedTools: ${allowedTools.join(', ')}` : '(no allowedTools)',
      addDirs?.length ? `addDirs: ${addDirs.join(', ')}` : null,
      locale ? `locale=${locale}` : null,
      awsEnv ? 'AWS credentials' : null,
      gitEnv && Object.keys(gitEnv).length > 0 ? 'Git credentials' : null,
      mcpConfigPath ? 'MCP config' : null,
      history.length > 0 ? `${history.length} history messages` : null,
      payload.files ? `${Array.isArray(payload.files) ? payload.files.length : 0} attached files` : null,
      conversationFiles.length > 0 ? `${conversationFiles.length} conversation files` : null,
    ].filter(Boolean).join(', ')
    logger.debug(`[chat] Spawning claude CLI for command [${commandId}]: ${logDetails}`)
    logger.debug(`[chat] serverConfig.claudeCodeConfig: ${JSON.stringify(serverConfig?.claudeCodeConfig ?? null)}`)
    const conversationIdStr = conversationId ?? undefined
    const handle = runClaudeCode({
      message: messageWithHistory,
      sendChunk,
      allowedTools,
      addDirs,
      locale,
      awsEnv: { ...awsEnv, ...gitEnv },
      mcpConfigPath,
      cwd: projectDir ? getWorkspaceDir(projectDir) : undefined,
      systemPrompt,
      policyContext: {
        tenantCode,
        projectCode,
        conversationId: conversationIdStr,
      },
    })
    // プロセスを管理 Map に登録
    processManager.register(commandId, handle)
    let result
    try {
      result = await handle.result
    } finally {
      processManager.remove(commandId)
    }
    logger.info(`[chat] Chat command completed [${commandId}]: output=${result.text.length} chars, ${getChunkIndex()} chunks sent, duration=${result.metadata.durationMs}ms`)
    // 完了チャンクを送信（metadata + toolCalls を含める）
    await sendDoneChunk(sendChunk, {
      text: result.text,
      metadata: result.metadata,
      ...(collectedToolCalls.length > 0 ? { toolCalls: collectedToolCalls } : {}),
    })

    // 一時ファイルをクリーンアップ
    cleanupDownloads?.()
    cleanupGitCredentials?.()

    return successResult(result.text)
  } catch (error) {
    cleanupDownloads?.()
    cleanupGitCredentials?.()
    return handleChatError(error, commandId, 'chat', sendChunk)
  }
}

/**
 * AWS認証情報とGit認証情報を構築する
 */
async function buildEnvironmentCredentials(
  payload: ChatPayload,
  client: ApiClient,
  projectDir?: string,
  projectConfig?: ProjectConfigResponse,
  projectCode?: string,
  sendChunk?: (type: ChatChunkType, content: string) => Promise<void>,
): Promise<{
  awsEnv: Record<string, string> | undefined
  gitEnv: Record<string, string> | undefined
  cleanupGitCredentials: (() => void) | undefined
}> {
  let awsEnv: Record<string, string> | undefined
  if (projectDir && projectConfig?.aws?.accounts?.length) {
    const awsResult = await buildAwsProfileCredentials(client, projectDir, projectConfig)
    awsEnv = awsResult.env
    if (sendChunk) await sendAwsCredentialNotices(awsResult, projectCode, sendChunk)
  } else {
    const awsAccountId = parseString(payload.awsAccountId) ?? undefined
    const awsResult = await buildSingleAccountAwsEnv(client, awsAccountId)
    awsEnv = awsResult.env
    if (sendChunk) await sendAwsCredentialNotices(awsResult, projectCode, sendChunk)
  }

  let gitEnv: Record<string, string> | undefined
  let cleanupGitCredentials: (() => void) | undefined
  if (projectConfig?.repositories?.length) {
    try {
      const gitCredResult = await buildGitCredentialEnv(client, projectConfig.repositories)
      gitEnv = gitCredResult.env
      cleanupGitCredentials = gitCredResult.cleanup
    } catch (error) {
      logger.warn(`[chat] Git credential setup failed: ${getErrorMessage(error)}`)
    }
  }

  return { awsEnv, gitEnv, cleanupGitCredentials }
}

/**
 * 添付ファイルをダウンロードし、通知を送信する
 */
async function downloadAttachments(
  payload: ChatPayload,
  client: ApiClient,
  agentId: string,
  projectDir?: string,
  conversationId?: string | null,
  commandId?: string,
  sendChunk?: (type: ChatChunkType, content: string) => Promise<void>,
): Promise<{
  filePathsNotice: string
  cleanup: (() => void) | undefined
}> {
  const chatFiles = parseChatFiles(payload.files)
  let filePathsNotice = ''
  let cleanup: (() => void) | undefined

  if (chatFiles.length > 0 && projectDir && conversationId) {
    const downloadResult = await downloadChatFiles(client, agentId, chatFiles, projectDir, conversationId)
    cleanup = downloadResult.cleanup
    if (downloadResult.downloadedPaths.length > 0) {
      filePathsNotice = `\n\n<attached_files>\n${downloadResult.downloadedPaths.map((p) => `- ${p}`).join('\n')}\n</attached_files>`
      logger.info(`[chat] Downloaded ${downloadResult.downloadedPaths.length} files for command [${commandId}]`)
    }
    if (downloadResult.failedCount > 0 && sendChunk) {
      await sendChunk('delta', `⚠️ ${downloadResult.failedCount}件のファイルのダウンロードに失敗しました\n\n`)
    }
  }

  return { filePathsNotice, cleanup }
}

export function buildConversationFileNotice(conversationFiles: ChatFileInfo[]): string {
  if (conversationFiles.length === 0) return ''
  const fileList = conversationFiles.map((f) =>
    `- fileId: ${f.fileId}, s3Key: ${f.s3Key}, filename: ${f.filename} (${f.contentType}, ${f.fileSize} bytes)`,
  ).join('\n')
  return `\n\n<conversation_files>\nFiles shared in this conversation. Use read_conversation_file tool to read their contents.\n${fileList}\n</conversation_files>`
}

export function buildMetadataNotice(
  conversationId: string | null,
  commandId: string,
  projectCode: string | undefined,
  mcpConfigPath?: string,
): string {
  if (!conversationId || !mcpConfigPath) return ''
  return `\n\n<message_metadata>\nconversationId: ${conversationId}\nmessageId: ${commandId}\nprojectCode: ${projectCode ?? ''}\n</message_metadata>`
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
