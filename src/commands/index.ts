import type { ApiClient } from '../api-client'
import { ERR_CHAT_REQUIRES_CLIENT, ERR_E2E_TEST_REQUIRES_CLIENT, ERR_CONFIG_SYNC_REQUIRES_CALLBACK, ERR_REBOOT_REQUIRES_CALLBACK, ERR_SETUP_REQUIRES_CALLBACK, ERR_UPDATE_REQUIRES_CALLBACK, ERR_SYNC_REPOSITORY_REQUIRES_CALLBACK, LOG_DEBUG_LIMIT } from '../constants'
import { logger } from '../logger'
import { getWorkspaceDir } from '../project-dir'
import { type AgentChatMode, type AgentCommandType, type AgentServerConfig, type CommandDispatch, type CommandResult, errorResult, type ProjectConfigResponse, type SyncRepositoryPayload, successResult } from '../types'
import type { RepoSyncResult } from '../repo-sync'
import { getErrorMessage } from '../utils'

import { executeChatCommand } from './chat-executor'
import { executeE2eScriptFix } from './e2e-script-fix-executor'
import { executeE2eTest } from './e2e-test-executor'
import { cancelProcess } from './process-manager'
import { fileDelete, fileList, fileMkdir, fileRead, fileRename, fileWrite } from './file-executor'
import { processKill, processList } from './process-executor'
import { executeShellCommand } from './shell-executor'

/** Options for command execution */
export interface ExecuteCommandOptions {
  commandId?: string
  client?: ApiClient
  serverConfig?: AgentServerConfig
  activeChatMode?: AgentChatMode
  activeChatModeExplicit?: boolean
  availableChatModes?: AgentChatMode[]
  agentId?: string
  projectDir?: string
  projectConfig?: ProjectConfigResponse
  mcpConfigPath?: string
  tenantCode?: string
  browserLocalPort?: number
  onSetup?: () => Promise<void>
  onConfigSync?: () => Promise<void>
  onReboot?: () => Promise<void>
  onUpdate?: () => Promise<void>
  onSyncRepository?: (repositoryCode: string, branch?: string) => Promise<RepoSyncResult>
  /**
   * E2E 専用のブラウザーセッションを子プロセス実行前にメインプロセスへ
   * 事前登録するコールバック。e2e_test ハンドラにのみ渡す。
   */
  getOrCreateBrowserSession?: (sessionId: string) => Promise<void>
  /** E2E 専用のブラウザーセッションを実行後にクローズするコールバック。 */
  closeBrowserSession?: (sessionId: string) => Promise<void>
}

/** Execution context passed to each handler */
interface CommandContext {
  p: Record<string, unknown>
  opts: ExecuteCommandOptions
  fileBaseDir: string | undefined
}

type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>

const AGENT_CHAT_MODES: AgentChatMode[] = ['claude_code', 'codex', 'api']

function isAgentChatMode(value: unknown): value is AgentChatMode {
  return typeof value === 'string' && AGENT_CHAT_MODES.includes(value as AgentChatMode)
}

function resolveCommandChatMode(
  commandType: 'chat' | 'e2e_test' | 'e2e_script_fix',
  payload: Record<string, unknown>,
  opts: ExecuteCommandOptions,
): CommandResult | AgentChatMode | undefined {
  const rawPayloadMode = payload.agentChatMode
  const payloadMode =
    rawPayloadMode === 'auto' || rawPayloadMode === undefined
      ? undefined
      : rawPayloadMode
  if (payloadMode !== undefined && !isAgentChatMode(payloadMode)) {
    return errorResult(`Unsupported agentChatMode: ${String(payloadMode)}`)
  }

  const overrideKey =
    commandType === 'e2e_test'
      ? 'e2eTest'
      : commandType === 'e2e_script_fix'
        ? 'e2eScriptFix'
        : 'chat'
  const overrideMode = opts.serverConfig?.agentChatModeOverrides?.[overrideKey]
  const selectedMode = payloadMode
    ?? overrideMode
    ?? (opts.activeChatModeExplicit === false ? undefined : opts.activeChatMode)

  if (!selectedMode) return undefined

  const availableModes = opts.availableChatModes ?? []
  const isExplicit = payloadMode !== undefined || overrideMode !== undefined
  if (isExplicit && availableModes.length > 0 && !availableModes.includes(selectedMode)) {
    return errorResult(`agentChatMode ${selectedMode} is not available on this agent`)
  }

  return selectedMode
}

const COMMAND_HANDLERS: Record<AgentCommandType, CommandHandler> = {
  execute_command: async ({ p }) => {
    const cmd = p.command
    logger.debug(`[shell] command="${String(cmd ?? '').substring(0, LOG_DEBUG_LIMIT)}"`)
    return executeShellCommand(p)
  },

  file_read: async ({ p, fileBaseDir }) => {
    const path = p.path
    logger.debug(`[file_read] path="${String(path ?? '')}"`)
    return fileRead(p, fileBaseDir)
  },

  file_write: async ({ p, fileBaseDir }) => {
    const path = p.path
    logger.debug(`[file_write] path="${String(path ?? '')}"`)
    return fileWrite(p, fileBaseDir)
  },

  file_list: async ({ p, fileBaseDir }) => {
    const path = p.path
    logger.debug(`[file_list] path="${String(path ?? '')}"`)
    return fileList(p, fileBaseDir)
  },

  file_rename: async ({ p, fileBaseDir }) => {
    const oldPath = p.oldPath
    const newPath = p.newPath
    logger.debug(`[file_rename] oldPath="${String(oldPath ?? '')}" newPath="${String(newPath ?? '')}"`)
    return fileRename(p, fileBaseDir)
  },

  file_delete: async ({ p, fileBaseDir }) => {
    const deletePath = p.path
    logger.debug(`[file_delete] path="${String(deletePath ?? '')}"`)
    return fileDelete(p, fileBaseDir)
  },

  file_mkdir: async ({ p, fileBaseDir }) => {
    const mkdirPath = p.path
    logger.debug(`[file_mkdir] path="${String(mkdirPath ?? '')}"`)
    return fileMkdir(p, fileBaseDir)
  },

  process_list: async () => processList(),

  process_kill: async ({ p }) => {
    const pid = p.pid
    logger.debug(`[process_kill] pid=${String(pid ?? '')}`)
    return processKill(p)
  },

  chat: async ({ p, opts }) => {
    if (!opts.commandId || !opts.client) {
      return errorResult(ERR_CHAT_REQUIRES_CLIENT)
    }
    const activeChatMode = resolveCommandChatMode('chat', p, opts)
    if (typeof activeChatMode === 'object') return activeChatMode
    return executeChatCommand({
      payload: p,
      commandId: opts.commandId,
      client: opts.client,
      serverConfig: opts.serverConfig,
      activeChatMode,
      availableChatModes: opts.availableChatModes,
      agentId: opts.agentId,
      projectDir: opts.projectDir,
      projectConfig: opts.projectConfig,
      mcpConfigPath: opts.mcpConfigPath,
      tenantCode: opts.tenantCode,
      browserLocalPort: opts.browserLocalPort,
    })
  },

  chat_cancel: async ({ p }) => {
    const targetCommandId = p.targetCommandId
    if (typeof targetCommandId !== 'string') {
      return errorResult('targetCommandId is required for chat_cancel')
    }
    logger.info(`[chat_cancel] Cancelling chat process: targetCommandId=${targetCommandId}`)
    const cancelled = cancelProcess(targetCommandId)
    return successResult({ cancelled, targetCommandId })
  },

  setup: async ({ opts }) => {
    if (!opts.onSetup) {
      return errorResult(ERR_SETUP_REQUIRES_CALLBACK)
    }
    await opts.onSetup()
    return successResult('setup completed')
  },

  config_sync: async ({ opts }) => {
    if (!opts.onConfigSync) {
      return errorResult(ERR_CONFIG_SYNC_REQUIRES_CALLBACK)
    }
    await opts.onConfigSync()
    return successResult('config sync completed')
  },

  reboot: async ({ opts }) => {
    if (!opts.onReboot) {
      return errorResult(ERR_REBOOT_REQUIRES_CALLBACK)
    }
    await opts.onReboot()
    return successResult('reboot initiated')
  },

  update: async ({ opts }) => {
    if (!opts.onUpdate) {
      return errorResult(ERR_UPDATE_REQUIRES_CALLBACK)
    }
    await opts.onUpdate()
    return successResult('update initiated')
  },

  sync_repository: async ({ p, opts }) => {
    if (!opts.onSyncRepository) {
      return errorResult(ERR_SYNC_REPOSITORY_REQUIRES_CALLBACK)
    }
    const repositoryCode = (p as SyncRepositoryPayload).repositoryCode
    if (typeof repositoryCode !== 'string' || !repositoryCode) {
      return errorResult('repositoryCode is required for sync_repository')
    }
    const branch = (p as SyncRepositoryPayload).branch
    const overrideBranch = typeof branch === 'string' && branch ? branch : undefined
    const result = await opts.onSyncRepository(repositoryCode, overrideBranch)
    return successResult(result)
  },

  e2e_test: async ({ p, opts }) => {
    if (!opts.commandId || !opts.client) {
      return errorResult(ERR_E2E_TEST_REQUIRES_CLIENT)
    }
    const activeChatMode = resolveCommandChatMode('e2e_test', p, opts)
    if (typeof activeChatMode === 'object') return activeChatMode
    return executeE2eTest({
      payload: p,
      commandId: opts.commandId,
      client: opts.client,
      serverConfig: opts.serverConfig,
      activeChatMode,
      agentId: opts.agentId,
      projectDir: opts.projectDir,
      projectConfig: opts.projectConfig,
      mcpConfigPath: opts.mcpConfigPath,
      tenantCode: opts.tenantCode,
      browserLocalPort: opts.browserLocalPort,
      getOrCreateBrowserSession: opts.getOrCreateBrowserSession,
      closeBrowserSession: opts.closeBrowserSession,
    })
  },

  ecs_launch: async ({ p }) => {
    // Loaded lazily so resident agents that never launch ECS tasks do not
    // pay the AWS SDK import cost. Payload may contain the oneshot token —
    // never log it here.
    const { ecsLaunch } = await import('../ecs/ecs-launcher')
    return ecsLaunch(p)
  },

  ecs_stop: async ({ p }) => {
    const { ecsStop } = await import('../ecs/ecs-launcher')
    return ecsStop(p)
  },

  e2e_script_fix: async ({ p, opts }) => {
    if (!opts.client) {
      return errorResult(ERR_E2E_TEST_REQUIRES_CLIENT)
    }
    const activeChatMode = resolveCommandChatMode('e2e_script_fix', p, opts)
    if (typeof activeChatMode === 'object') return activeChatMode
    return executeE2eScriptFix({
      payload: p as { testCaseId?: unknown; message?: unknown; currentScript?: unknown },
      client: opts.client,
      tenantCode: opts.tenantCode,
      projectCode: opts.projectConfig?.project?.projectCode,
      agentId: opts.agentId,
      commandId: opts.commandId,
      serverConfig: opts.serverConfig,
      activeChatMode,
      projectDir: opts.projectDir,
      projectConfig: opts.projectConfig,
      mcpConfigPath: opts.mcpConfigPath,
      browserLocalPort: opts.browserLocalPort,
    })
  },
}

// Overload: type-safe discriminated union
export async function executeCommand(command: CommandDispatch, options?: ExecuteCommandOptions): Promise<CommandResult>
// Overload: backward-compatible loose signature
export async function executeCommand(type: AgentCommandType, payload: Record<string, unknown>, options?: ExecuteCommandOptions): Promise<CommandResult>
// Implementation
export async function executeCommand(
  typeOrCommand: AgentCommandType | CommandDispatch,
  payloadOrOptions?: Record<string, unknown> | ExecuteCommandOptions,
  options?: ExecuteCommandOptions,
): Promise<CommandResult> {
  const type = typeof typeOrCommand === 'string' ? typeOrCommand : typeOrCommand.type
  // Runtime payloads come from external API, so cast is safe — runtime validation happens in each executor
  let p: Record<string, unknown>
  let opts: ExecuteCommandOptions

  if (typeof typeOrCommand === 'string') {
    p = payloadOrOptions as Record<string, unknown>
    opts = options ?? {}
  } else {
    p = typeOrCommand.payload as Record<string, unknown>
    opts = (payloadOrOptions as ExecuteCommandOptions | undefined) ?? {}
  }

  const fileBaseDir = opts.projectDir ? getWorkspaceDir(opts.projectDir) : undefined

  logger.debug(`Executing command: type=${type}`)
  try {
    const handler = COMMAND_HANDLERS[type as AgentCommandType]
    if (!handler) {
      logger.warn(`Unknown command type: ${type}`)
      return errorResult(`Unknown command type: ${type}`)
    }
    return await handler({ p, opts, fileBaseDir })
  } catch (error) {
    const message = getErrorMessage(error)
    logger.error(`Command execution failed (${type}): ${message}`)
    return errorResult(message)
  }
}

export { executeShellCommand } from './shell-executor'
export { fileDelete, fileList, fileMkdir, fileRead, fileRename, fileWrite } from './file-executor'
export { processKill, processList } from './process-executor'
