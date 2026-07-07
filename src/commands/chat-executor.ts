import { ApiClient } from '../api-client'
import { type AwsCredentialResult, buildAwsProfileCredentials, buildSingleAccountAwsEnv } from '../aws-credential-builder'
import { CHAT_MAX_ATTEMPTS, CHAT_RETRY_DELAY_MS, ERR_AGENT_ID_REQUIRED, ERR_MESSAGE_REQUIRED, LOG_MESSAGE_LIMIT } from '../constants'
import { buildGitCredentialEnv } from '../git-credential-setup'
import { logger } from '../logger'
import { type AgentChatMode, type AgentServerConfig, type ChatChunkType, type ChatFileInfo, type ChatPayload, type CommandResult, errorResult, type ProjectConfigResponse, successResult } from '../types'
import { getErrorMessage, parseString, sleep, truncateString } from '../utils'

import { getAutoAddDirs, getWorkspaceDir } from '../project-dir'
import { ensureAllowedToolsInSettings } from '../utils/claude-settings'
import { executeApiChatCommand } from './api-chat-executor'
import type { StreamJsonUsage } from './claude-code-stream'
import { runClaudeCode } from './claude-code-runner'
import { runCodex } from './codex-runner'
import { downloadChatFiles, parseChatFiles, parseConversationFiles } from './file-transfer'
import { getProcessManager } from './process-manager'
import { createChunkSender, formatHistoryForClaudeCode, handleChatError, parseHistory, sendDoneChunk } from './shared-chat-utils'

// Re-export for backward compatibility with existing consumers
export { buildClaudeArgs, buildCleanEnv, _resetCleanEnvCache } from './claude-code-runner'

/** 実行中のチャットプロセスを commandId で管理 */
const processManager = getProcessManager()

interface CliChatResult {
  text: string
  usage?: StreamJsonUsage
  metadata: {
    args: string[]
    exitCode: number | null
    hasStderr: boolean
    durationMs: number
  }
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
  browserLocalPort?: number
}

/**
 * エージェントチャットモードに応じてチャットメッセージを処理する
 * - claude_code: Claude Code CLI を使用（デフォルト）
 * - codex: Codex CLI を使用
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
    browserLocalPort,
  } = options

  if (!agentId) {
    return errorResult(ERR_AGENT_ID_REQUIRED)
  }

  const mode = activeChatMode ?? 'claude_code'

  // API モードでは projectConfig.envVars が反映されないため、Web で
  // 設定されている envVars がある場合に warn を出す（ユーザーへの hint）。
  if (mode === 'api' && projectConfig?.envVars && Object.keys(projectConfig.envVars).length > 0) {
    const keys = Object.keys(projectConfig.envVars).sort().join(', ')
    logger.warn(
      `[chat] API mode is selected but Web-configured envVars (${keys}) are not applied in API mode. ` +
        `These overrides are only effective in CLI modes.`,
    )
  }

  switch (mode) {
    case 'api':
      return executeApiChatCommand(payload, commandId, client, serverConfig, agentId)
    case 'codex':
      return executeCliChat('codex', payload, commandId, client, agentId, serverConfig, projectDir, projectConfig, mcpConfigPath, tenantCode, browserLocalPort)
    case 'claude_code':
    default:
      return executeCliChat('claude_code', payload, commandId, client, agentId, serverConfig, projectDir, projectConfig, mcpConfigPath, tenantCode, browserLocalPort)
  }
}

/**
 * Agent CLI を使用してチャットメッセージを処理する
 * 失敗した場合に最大 CHAT_MAX_ATTEMPTS 回試行する（キャンセル時を除く）
 */
async function executeCliChat(
  mode: 'claude_code' | 'codex',
  payload: ChatPayload,
  commandId: string,
  client: ApiClient,
  agentId: string,
  serverConfig?: AgentServerConfig,
  projectDir?: string,
  projectConfig?: ProjectConfigResponse,
  mcpConfigPath?: string,
  tenantCode?: string,
  browserLocalPort?: number,
): Promise<CommandResult> {
  let lastResult: CommandResult = { success: false, error: 'Chat command failed after all retry attempts' }

  for (let attempt = 1; attempt <= CHAT_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      logger.info(`[chat] Retrying chat command [${commandId}] (attempt ${attempt}/${CHAT_MAX_ATTEMPTS})`)
      await sleep(CHAT_RETRY_DELAY_MS)
    }

    const result = await executeCliChatOnce(
      mode, payload, commandId, client, agentId, serverConfig, projectDir, projectConfig, mcpConfigPath, tenantCode, browserLocalPort,
    )

    if (result.success) return result

    // キャンセルされた場合はリトライしない
    const errorMsg = typeof result.error === 'string' ? result.error : ''
    if (errorMsg.toLowerCase().includes('cancel')) return result

    lastResult = result

    if (attempt < CHAT_MAX_ATTEMPTS) {
      logger.warn(`[chat] Chat command failed [${commandId}], will retry: ${errorMsg}`)
    }
  }

  return lastResult
}

/**
 * Agent CLI を使用してチャットメッセージを1回試行する
 * サブプロセスとして起動し、stdout をストリーミングで読み取り、
 * チャンクとしてAPIに送信する
 */
async function executeCliChatOnce(
  mode: 'claude_code' | 'codex',
  payload: ChatPayload,
  commandId: string,
  client: ApiClient,
  agentId: string,
  serverConfig?: AgentServerConfig,
  projectDir?: string,
  projectConfig?: ProjectConfigResponse,
  mcpConfigPath?: string,
  tenantCode?: string,
  browserLocalPort?: number,
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
      } catch (err: unknown) {
        logger.warn(`[chat] Failed to parse tool_call JSON: ${getErrorMessage(err)}`)
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
      } catch (err: unknown) {
        logger.warn(`[chat] Failed to parse tool_result JSON: ${getErrorMessage(err)}`)
      }
    }
    return rawSendChunk(type, content)
  }

  let cleanupDownloads: (() => void) | undefined
  let cleanupGitCredentials: (() => void) | undefined

  try {
    const allowedTools = mode === 'claude_code' ? serverConfig?.claudeCodeConfig?.allowedTools : undefined
    const systemPrompt = mode === 'codex'
      ? (serverConfig?.codexConfig?.systemPrompt ?? serverConfig?.claudeCodeConfig?.systemPrompt)
      : serverConfig?.claudeCodeConfig?.systemPrompt
    const model = mode === 'codex'
      ? (serverConfig?.codexConfig?.model ?? serverConfig?.claudeCodeConfig?.model)
      : serverConfig?.claudeCodeConfig?.model
    const serverAddDirs = mode === 'codex'
      ? (serverConfig?.codexConfig?.addDirs ?? serverConfig?.claudeCodeConfig?.addDirs ?? [])
      : (serverConfig?.claudeCodeConfig?.addDirs ?? [])
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

    // 会話履歴をメッセージに埋め込む（CLI用）
    const history = parseHistory(payload.history)

    // file_upload ツールに必要なメタデータをメッセージに付加
    const metadataNotice = buildMetadataNotice(conversationId, commandId, projectCode, mcpConfigPath)

    const messageWithHistory = formatHistoryForClaudeCode(history, message + filePathsNotice + conversationFileNotice + metadataNotice)

    // Ensure allowedTools are registered in Claude Code settings.json
    if (mode === 'claude_code' && allowedTools?.length) {
      ensureAllowedToolsInSettings(allowedTools)
    }

    const logDetails = [
      allowedTools?.length ? `allowedTools: ${allowedTools.join(', ')}` : '(no allowedTools)',
      addDirs?.length ? `addDirs: ${addDirs.join(', ')}` : null,
      model ? `model=${model}` : null,
      locale ? `locale=${locale}` : null,
      awsEnv ? 'AWS credentials' : null,
      gitEnv && Object.keys(gitEnv).length > 0 ? 'Git credentials' : null,
      mcpConfigPath ? 'MCP config' : null,
      history.length > 0 ? `${history.length} history messages` : null,
      payload.files ? `${Array.isArray(payload.files) ? payload.files.length : 0} attached files` : null,
      conversationFiles.length > 0 ? `${conversationFiles.length} conversation files` : null,
    ].filter(Boolean).join(', ')
    const cliLogName = mode === 'claude_code' ? 'claude' : 'codex'
    logger.debug(`[chat] Spawning ${cliLogName} CLI for command [${commandId}]: ${logDetails}`)
    logger.debug(`[chat] serverConfig.claudeCodeConfig: ${JSON.stringify(serverConfig?.claudeCodeConfig ?? null)}`)
    const conversationIdStr = conversationId ?? undefined
    const runnerOptions = {
      message: messageWithHistory,
      sendChunk,
      addDirs,
      locale,
      awsEnv: { ...awsEnv, ...gitEnv },
      cwd: projectDir ? getWorkspaceDir(projectDir) : undefined,
      systemPrompt,
      model,
      policyContext: {
        tenantCode,
        projectCode,
        conversationId: conversationIdStr,
        browserSessionId: parseString(payload.browserSessionId) ?? undefined,
        browserLocalPort,
        ...(payload.policyContext?.e2eExecutionId && {
          e2eExecutionId: payload.policyContext.e2eExecutionId,
        }),
        ...(payload.policyContext?.e2eTestCaseId && {
          e2eTestCaseId: payload.policyContext.e2eTestCaseId,
        }),
      },
      envVarsOverride: projectConfig?.envVars,
    }
    const handle = mode === 'codex'
      ? runCodex(runnerOptions)
      : runClaudeCode({
          ...runnerOptions,
          allowedTools,
          mcpConfigPath,
        })
    // プロセスを管理 Map に登録
    processManager.register(commandId, handle)
    let result: CliChatResult
    try {
      result = await handle.result
    } finally {
      processManager.remove(commandId)
    }
    const usageLog = result.usage
      ? ` in=${result.usage.input_tokens} out=${result.usage.output_tokens} cost=$${result.usage.total_cost_usd?.toFixed(6) ?? '?'}`
      : ''
    logger.info(`[chat] Chat command completed [${commandId}]: output=${result.text.length} chars, ${getChunkIndex()} chunks sent, duration=${result.metadata.durationMs}ms${usageLog}`)
    // 完了チャンクを送信（metadata + toolCalls + usage を含める）
    const usage = result.usage
      ? {
          totalInputTokens: result.usage.input_tokens,
          totalOutputTokens: result.usage.output_tokens,
          totalTokens: result.usage.input_tokens + result.usage.output_tokens,
          cacheCreationInputTokens: result.usage.cache_creation_input_tokens,
          cacheReadInputTokens: result.usage.cache_read_input_tokens,
          totalCostUsd: result.usage.total_cost_usd,
        }
      : undefined
    await sendDoneChunk(sendChunk, {
      text: result.text,
      metadata: result.metadata,
      ...(collectedToolCalls.length > 0 ? { toolCalls: collectedToolCalls } : {}),
      ...(usage ? { usage } : {}),
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
    const parts: string[] = []
    // 画像ファイルは @path 形式で付加（Claude Code CLI が画像として認識する）
    if (downloadResult.imagePaths.length > 0) {
      parts.push(downloadResult.imagePaths.map((p) => `@${p}`).join('\n'))
    }
    // 非画像ファイルは <attached_files> リストとして付加
    // ローカルパスにダウンロード済みなので Read tool で読むよう明示し、
    // S3 上の会話ファイル用 read_conversation_file との混同を防ぐ
    if (downloadResult.downloadedPaths.length > 0) {
      parts.push(
        `<attached_files>\nThe following files have been downloaded to local paths. Use the Read tool to read them directly — do NOT use read_conversation_file for these.\n${downloadResult.downloadedPaths.map((p) => `- ${p}`).join('\n')}\n</attached_files>`,
      )
    }
    if (parts.length > 0) {
      filePathsNotice = '\n\n' + parts.join('\n\n')
      logger.info(
        `[chat] Downloaded ${downloadResult.imagePaths.length} image(s) and ${downloadResult.downloadedPaths.length} file(s) for command [${commandId}]`,
      )
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
