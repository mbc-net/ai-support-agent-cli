import type { ApiClient } from '../api-client'
import { ERR_CHAT_REQUIRES_CLIENT, ERR_E2E_TEST_REQUIRES_CLIENT, ERR_CONFIG_SYNC_REQUIRES_CALLBACK, ERR_REBOOT_REQUIRES_CALLBACK, ERR_SETUP_REQUIRES_CALLBACK, ERR_UPDATE_REQUIRES_CALLBACK, ERR_SYNC_REPOSITORY_REQUIRES_CALLBACK, LOG_DEBUG_LIMIT } from '../constants'
import { logger } from '../logger'
import { getWorkspaceDir } from '../project-dir'
import { type AgentChatMode, type AgentCommandType, type CommandDispatch, type CommandResult, errorResult, type ReadonlyDiagnosticPayload, type ServerSetupExecPayload, type SshExecCredential, type SshExecPayload, type SyncRepositoryPayload, successResult } from '../types'
import type { RepoSyncResult } from '../repo-sync'
import { validateCommand } from '../security'
import { getErrorMessage } from '../utils'

import { type AgentExecutionContext, forwardAgentExecutionContext } from './agent-execution-context'
import { executeChatCommand } from './chat-executor'
import { executeE2eScriptFix } from './e2e-script-fix-executor'
import { executeE2eTest } from './e2e-test-executor'
import { cancelProcess, cancelProcessWhenRegistered } from './process-manager'
import { fileDelete, fileList, fileMkdir, fileRead, fileRename, fileWrite } from './file-executor'
import { processKill, processList } from './process-executor'
import { executeShellCommand } from './shell-executor'

/** Options for command execution */
export interface ExecuteCommandOptions extends AgentExecutionContext {
  commandId?: string
  client?: ApiClient
  /**
   * Whether `activeChatMode` was set explicitly rather than defaulted. Only
   * `executeCommand` itself reads it when resolving the per-command mode, so
   * it stays out of {@link AgentExecutionContext} and is never handed down.
   */
  activeChatModeExplicit?: boolean
  /**
   * `commandId` is passed through so a Docker-mode config sync/setup that
   * detects a customization change and fires `performDockerRebuild()` can
   * tell `shutdown()` to exclude this very command from its in-flight drain
   * wait (it can only be removed from `inFlightCommands` after this handler
   * returns, so waiting on it would needlessly delay the rebuild). See
   * `ConfigSyncDeps.onDockerRebuild`'s doc comment.
   */
  onSetup?: (commandId?: string) => Promise<void>
  onConfigSync?: (commandId?: string) => Promise<void>
  /**
   * `commandId` is passed through so the handler can tell `shutdown()` to
   * exclude this very command from its in-flight drain wait (it can only be
   * removed from `inFlightCommands` after this handler returns, so waiting on
   * it would deadlock). See `ProjectAgent.performReboot`/`performUpdate`.
   */
  onReboot?: (commandId?: string) => Promise<void>
  onUpdate?: (commandId?: string) => Promise<void>
  onSyncRepository?: (repositoryCode: string, branch?: string) => Promise<RepoSyncResult>
  /**
   * E2E 専用のブラウザーセッションを子プロセス実行前にメインプロセスへ
   * 事前登録するコールバック。e2e_test ハンドラにのみ渡す。
   */
  getOrCreateBrowserSession?: (sessionId: string) => Promise<void>
  /** E2E 専用のブラウザーセッションを実行後にクローズするコールバック。 */
  closeBrowserSession?: (sessionId: string) => Promise<void>
}

/** Bounds for the agent-side timeout of a readonly_diagnostic command (seconds). */
const READONLY_DIAGNOSTIC_MIN_TIMEOUT_SECONDS = 5
const READONLY_DIAGNOSTIC_MAX_TIMEOUT_SECONDS = 60
const READONLY_DIAGNOSTIC_DEFAULT_TIMEOUT_SECONDS = 30

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
  const source = payloadMode !== undefined
    ? 'payload'
    : overrideMode !== undefined
      ? `${overrideKey} override`
      : opts.activeChatModeExplicit === false
        ? 'fallback order'
        : opts.activeChatMode !== undefined
          ? 'activeChatMode'
          : 'fallback order'
  logger.debug(`[${commandType}] Agent chat mode source: ${source}${selectedMode ? ` (${selectedMode})` : ''}`)

  if (!selectedMode) return undefined

  const availableModes = opts.availableChatModes ?? []
  const isExplicit = payloadMode !== undefined || overrideMode !== undefined
  if (isExplicit && availableModes.length > 0 && !availableModes.includes(selectedMode)) {
    return errorResult(`agentChatMode ${selectedMode} is not available on this agent`)
  }

  return selectedMode
}

/**
 * デバッグログに出す payload 項目。
 *
 * 各ハンドラが `logger.debug(`[file_read] path=...`)` のように自前で出して
 * いたが、ラベルはハンドラのキーと一致していなければ意味を成さない。
 * コピー&ペーストでラベルを直し忘れても型もテストも通り、**障害調査のときに
 * 別のコマンドの名前が付いたログを読むことになる**。
 *
 * ラベルは `executeCommand` が受け取った `type` から作るので、ここには
 * 「出す項目」だけを書く。取り違えようがない。
 *
 * `execute_command`（ラベルが `[shell]` で値を切り詰める）と `chat_cancel`
 * （検証を伴う）は形が違うため、従来どおりハンドラ側で出す。
 */
const DEBUG_LOGGED_PAYLOAD_FIELDS: Partial<
  Record<AgentCommandType, readonly string[]>
> = {
  file_read: ['path'],
  file_write: ['path'],
  file_list: ['path'],
  file_rename: ['oldPath', 'newPath'],
  file_delete: ['path'],
  file_mkdir: ['path'],
  process_kill: ['pid'],
}

/** `[<type>] key="value" ...` の形でデバッグログを出す */
function logPayloadFields(
  type: AgentCommandType,
  p: Record<string, unknown>,
): void {
  const fields = DEBUG_LOGGED_PAYLOAD_FIELDS[type]
  if (!fields) return
  const rendered = fields
    .map((field) => `${field}="${String(p[field] ?? '')}"`)
    .join(' ')
  logger.debug(`[${type}] ${rendered}`)
}

const COMMAND_HANDLERS: Record<AgentCommandType, CommandHandler> = {
  execute_command: async ({ p }) => {
    const cmd = p.command
    logger.debug(`[shell] command="${String(cmd ?? '').substring(0, LOG_DEBUG_LIMIT)}"`)
    return executeShellCommand(p)
  },

  file_read: async ({ p, fileBaseDir }) => fileRead(p, fileBaseDir),

  file_write: async ({ p, fileBaseDir }) => fileWrite(p, fileBaseDir),

  file_list: async ({ p, fileBaseDir }) => fileList(p, fileBaseDir),

  file_rename: async ({ p, fileBaseDir }) => fileRename(p, fileBaseDir),

  file_delete: async ({ p, fileBaseDir }) => fileDelete(p, fileBaseDir),

  file_mkdir: async ({ p, fileBaseDir }) => fileMkdir(p, fileBaseDir),

  process_list: async () => processList(),

  process_kill: async ({ p }) => processKill(p),

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
      ...forwardAgentExecutionContext(opts, { activeChatMode }),
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
    await opts.onSetup(opts.commandId)
    return successResult('setup completed')
  },

  config_sync: async ({ opts }) => {
    if (!opts.onConfigSync) {
      return errorResult(ERR_CONFIG_SYNC_REQUIRES_CALLBACK)
    }
    await opts.onConfigSync(opts.commandId)
    return successResult('config sync completed')
  },

  reboot: async ({ opts }) => {
    if (!opts.onReboot) {
      return errorResult(ERR_REBOOT_REQUIRES_CALLBACK)
    }
    await opts.onReboot(opts.commandId)
    return successResult('reboot initiated')
  },

  update: async ({ opts }) => {
    if (!opts.onUpdate) {
      return errorResult(ERR_UPDATE_REQUIRES_CALLBACK)
    }
    await opts.onUpdate(opts.commandId)
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
      getOrCreateBrowserSession: opts.getOrCreateBrowserSession,
      closeBrowserSession: opts.closeBrowserSession,
      ...forwardAgentExecutionContext(opts, { activeChatMode }),
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

  ssh_source_ip_sync: async ({ p, opts }) => {
    if (!opts.commandId || !opts.client) return errorResult('SSH policy requires client context')
    const { runSshSourceIpSync } = await import('../server-setup/ssh-source-ip-sync')
    return runSshSourceIpSync(p, {commandId:opts.commandId,client:opts.client,agentId:opts.agentId})
  },
  ssh_source_ip_inspect: async ({ p, opts }) => {
    if (!opts.commandId || !opts.client) return errorResult('SSH policy inspection requires client context')
    const { runSshSourceIpSync } = await import('../server-setup/ssh-source-ip-sync')
    return runSshSourceIpSync(p, {commandId:opts.commandId,client:opts.client,agentId:opts.agentId}, true)
  },

  server_setup_exec: async ({ p, opts }) => {
    // Loaded lazily so agents that never run server setup do not pay the
    // Ansible dispatch cost. Payload/response may involve an SSH private
    // key — never log it here.
    if (!opts.commandId || !opts.client) {
      return errorResult('server_setup_exec requires client context')
    }
    const { runServerSetup } = await import('../server-setup/server-setup-runner')
    return runServerSetup(p as unknown as ServerSetupExecPayload, {
      commandId: opts.commandId,
      client: opts.client,
      agentId: opts.agentId,
    })
  },

  server_setup_cancel: async ({ p }) => {
    const targetCommandId = p.targetCommandId
    if (typeof targetCommandId !== 'string' || !targetCommandId) {
      return errorResult('targetCommandId is required for server_setup_cancel')
    }
    logger.info(`[server_setup_cancel] Cancelling setup process: targetCommandId=${targetCommandId}`)
    const cancelled = cancelProcessWhenRegistered(targetCommandId)
    return successResult({ cancelled, targetCommandId })
  },

  ssh_exec: async ({ p, opts }) => {
    // Loaded lazily so agents that never run ssh_exec do not pay the
    // ssh2/socks require() cost. Payload/response may involve an SSH
    // private key, password, or Tailscale authkey — never log them here.
    if (!opts.commandId || !opts.client) {
      return errorResult('ssh_exec requires client context')
    }
    const sshHostId = (p as SshExecPayload).sshHostId
    if (typeof sshHostId !== 'string' || !sshHostId) {
      return errorResult('sshHostId is required for ssh_exec')
    }
    const command = (p as SshExecPayload).command
    if (typeof command !== 'string' || !command) {
      return errorResult('command is required for ssh_exec')
    }
    const rawTimeout = (p as SshExecPayload).timeoutSeconds
    const timeoutSeconds = typeof rawTimeout === 'number' ? rawTimeout : undefined

    logger.debug(`[ssh_exec] sshHostId=${sshHostId}`)
    try {
      const { fetchSshExecCredential } = await import('./ssh-credential-client')
      const { executeSshCommand } = await import('./ssh-executor')
      const credential = await fetchSshExecCredential(opts.client, opts.commandId, opts.agentId ?? '')
      const output = await executeSshCommand(credential, command, timeoutSeconds)
      return successResult(output)
    } catch (error) {
      return errorResult(getErrorMessage(error))
    }
  },

  readonly_diagnostic: async ({ p, opts }) => {
    // Alarm AI-check read-only diagnostic. Unlike ssh_exec, the command string
    // is never taken from the payload: the argv is rebuilt from the local
    // catalog and must match the api's expectedCommand. The JIT credential is
    // single-use (409 on a second fetch) — never log it and never re-fetch.
    if (!opts.commandId || !opts.client) {
      return errorResult('readonly_diagnostic requires client context')
    }
    const payload = p as ReadonlyDiagnosticPayload
    const {
      buildLogTailPreflight,
      buildReadonlyDiagnostic,
      firstLines,
      READONLY_DIAGNOSTIC_MAX_OUTPUT_BYTES,
      readonlyDiagnosticCommandText,
      TOP_PROCESSES_OUTPUT_LINES,
      truncateUtf8,
      validateReadonlyLogPath,
    } = await import('./readonly-diagnostic-catalog')

    const allowedLogPaths = payload.allowedLogPaths
    const built =
      Array.isArray(allowedLogPaths) && allowedLogPaths.every((path) => typeof path === 'string')
        ? buildReadonlyDiagnostic(payload.catalogId, payload.params, { allowedLogPaths })
        : null
    if (!built) {
      return errorResult('readonly_diagnostic rejected: invalid catalog request')
    }
    const command = readonlyDiagnosticCommandText(built.argv)
    if (command !== payload.expectedCommand) {
      return errorResult('readonly_diagnostic rejected: command mismatch')
    }
    const blocked = validateCommand(command)
    if (blocked) {
      return errorResult(`readonly_diagnostic rejected: ${blocked}`)
    }

    const rawTimeout = payload.timeoutSeconds
    const timeoutSeconds = typeof rawTimeout === 'number' && Number.isFinite(rawTimeout)
      ? Math.min(Math.max(rawTimeout, READONLY_DIAGNOSTIC_MIN_TIMEOUT_SECONDS), READONLY_DIAGNOSTIC_MAX_TIMEOUT_SECONDS)
      : READONLY_DIAGNOSTIC_DEFAULT_TIMEOUT_SECONDS
    const rawMaxBytes = payload.maxOutputBytes
    const maxOutputBytes = typeof rawMaxBytes === 'number' && Number.isInteger(rawMaxBytes) && rawMaxBytes > 0
      ? Math.min(rawMaxBytes, READONLY_DIAGNOSTIC_MAX_OUTPUT_BYTES)
      : READONLY_DIAGNOSTIC_MAX_OUTPUT_BYTES

    // log_tail: prepare the symlink / regular-file checks up front so a bad
    // path is rejected before the single-use credential is consumed.
    const preflight = built.id === 'log_tail' ? buildLogTailPreflight(String(built.params.path)) : undefined
    if (preflight === null) {
      return errorResult('readonly_diagnostic rejected: invalid catalog request')
    }
    if (preflight) {
      for (const argv of [preflight.resolve, preflight.regularFile]) {
        const preflightBlocked = validateCommand(readonlyDiagnosticCommandText(argv))
        if (preflightBlocked) return errorResult(`readonly_diagnostic rejected: ${preflightBlocked}`)
      }
    }

    // Never log the command output or the credential — only the catalog id.
    logger.debug(`[readonly_diagnostic] catalogId=${built.id}`)
    let credential: SshExecCredential
    try {
      credential = await opts.client.getReadonlyDiagnosticCredential(opts.commandId, opts.agentId ?? '')
    } catch (error) {
      return errorResult(`Failed to fetch read-only diagnostic credential: ${getErrorMessage(error)}`)
    }
    try {
      const { executeSshCommand } = await import('./ssh-executor')
      // All SSH calls share one timeout budget so the whole run stays within
      // what the api waits for. The credential is fetched once and reused.
      const deadline = Date.now() + timeoutSeconds * 1000
      const runRemote = async (argv: readonly string[]): Promise<string | null> => {
        const remainingSeconds = Math.ceil((deadline - Date.now()) / 1000)
        if (remainingSeconds <= 0) return null
        return executeSshCommand(credential, readonlyDiagnosticCommandText(argv), remainingSeconds)
      }

      if (preflight) {
        const path = String(built.params.path)
        const resolved = await runRemote(preflight.resolve)
        if (resolved === null) return errorResult('readonly_diagnostic timed out')
        // executeSshCommand returns plain stdout only on exit 0, so an exact
        // match also proves readlink succeeded. Equality with the requested
        // path means no component is a symlink; re-check the allowlist anyway.
        if (resolved !== `${path}\n` || validateReadonlyLogPath(resolved.slice(0, -1)) === null) {
          return errorResult('readonly_diagnostic rejected: log path is not a plain file under the allowlist (symlink or missing)')
        }
        const regular = await runRemote(preflight.regularFile)
        if (regular === null) return errorResult('readonly_diagnostic timed out')
        if (regular !== '') {
          return errorResult('readonly_diagnostic rejected: log path is not a regular file')
        }
      }

      const raw = await runRemote(built.argv)
      if (raw === null) return errorResult('readonly_diagnostic timed out')
      const shaped = built.id === 'top_processes' ? firstLines(raw, TOP_PROCESSES_OUTPUT_LINES) : raw
      const { text: output, truncated } = truncateUtf8(shaped, maxOutputBytes)
      return successResult({ command, output, truncated })
    } catch (error) {
      return errorResult(getErrorMessage(error))
    }
  },

  backup_inspect: async ({ p, opts }) => {
    const { executeBackupInspect } = await import('../backup/backup-inspect-command')
    return executeBackupInspect(p, opts.serverConfig?.capabilities?.backup_executor === true)
  },

  backup_export: async ({ p, opts }) => {
    const { executeBackupExport } = await import('../backup/backup-export-command')
    return executeBackupExport(p, opts.serverConfig?.capabilities?.backup_executor === true, opts.commandId)
  },

  backup_verify: async ({ p, opts }) => {
    const { executeBackupVerify } = await import('../backup/backup-verify-command')
    return executeBackupVerify(p, opts.serverConfig?.capabilities?.backup_executor === true, opts.commandId)
  },

  tls_cert_check: async ({ p }) => {
    // Loaded lazily: agents that never monitor certificates should not pay the
    // module cost. No credentials are involved — the handshake reads the
    // public certificate and sends nothing.
    const { buildTlsCertCheckRequest } = await import('./tls-cert-check')
    const request = buildTlsCertCheckRequest(p)
    if ('error' in request) return errorResult(request.error)

    const { collectTlsCertificates } = await import(
      '../tls-cert/tls-cert-collector'
    )
    const observations = await collectTlsCertificates(request.targets, {
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      ...(request.concurrency !== undefined
        ? { concurrency: request.concurrency }
        : {}),
    })
    return successResult({ observations })
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
      commandId: opts.commandId,
      ...forwardAgentExecutionContext(opts, { activeChatMode }),
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
    logPayloadFields(type as AgentCommandType, p)
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
