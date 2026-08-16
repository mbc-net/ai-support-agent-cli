import * as os from 'os'

import { type AutoUpdaterHandle, startAutoUpdater } from './auto-updater'
import { resolveAutoUpdateEnablement } from './auto-update-enablement'
import { createAutoUpdateClients, createAutoUpdateGate } from './auto-update-gate'
import { describeSelfUpdateBlockReason, resolveSelfUpdateCapability } from './self-update-capability'
import { AGENT_VERSION, DEFAULT_API_URL, DEFAULT_HEARTBEAT_INTERVAL, DEFAULT_POLL_INTERVAL, PROJECT_CODE_CLI_DIRECT, PROJECT_CODE_ENV_DEFAULT, DOCKER_UPDATE_EXIT_CODE, ENV_VARS } from './constants'
import { getProjectList, loadConfig, saveConfig } from './config-manager'
import { t } from './i18n'
import { logger } from './logger'
import { ChildProcessManager } from './child-process-manager'
import { ProjectAgent } from './project-agent'
import { captureException, flushSentry, initSentry } from './sentry'
import { getSystemInfo } from './system-info'
import type { AgentChatMode, AutoUpdateConfig, ProjectRegistration, ReleaseChannel } from './types'
import { detectChannelFromVersion } from './update-checker'
import { exitWithError, getErrorMessage, isInDocker, nowIso, validateApiUrl } from './utils'
import { ApiClient } from './api-client'
import { startConfigWatcher } from './config-watcher'
import { writePidFile, removePidFile, isAlreadyRunning, readPidFile } from './pid-manager'
import { cleanupStaleServerSetupDirs } from './server-setup/server-setup-runner'
import { extractTokenId, resolveDirectStartTarget, splitProjectRef } from './utils/token-utils'
import { TerminalSession } from './terminal/terminal-session'

export { extractTokenId }

export interface RunnerOptions {
  token?: string
  apiUrl?: string
  pollInterval?: number
  heartbeatInterval?: number
  verbose?: boolean
  autoUpdate?: boolean
  updateChannel?: ReleaseChannel
  /**
   * Filter to a single project. Format: "tenantCode/projectCode"
   * When set, only the matching project is started.
   * Used by DockerSupervisor to spawn one container per project.
   */
  project?: string
}

export function startProjectAgent(
  project: ProjectRegistration,
  agentId: string,
  options: {
    pollInterval: number
    heartbeatInterval: number
    agentChatMode?: AgentChatMode
    defaultProjectDir?: string
  },
): { stop: () => void; client: import('./api-client').ApiClient; agent: ProjectAgent } {
  const agent = new ProjectAgent(project, agentId, options, options.agentChatMode, options.defaultProjectDir)
  agent.start()
  return {
    stop: () => agent.stop(),
    client: agent.getClient(),
    agent,
  }
}

function resolveIntervals(options: RunnerOptions): {
  pollInterval: number
  heartbeatInterval: number
} {
  return {
    pollInterval: options.pollInterval ?? DEFAULT_POLL_INTERVAL,
    heartbeatInterval: options.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
  }
}

export type ShutdownTarget =
  | { kind: 'agents'; agents: { stop: () => void | Promise<void> }[] }
  | { kind: 'processManager'; processManager: ChildProcessManager }

export function setupShutdownHandlers(
  target: ShutdownTarget,
  updater?: AutoUpdaterHandle,
): void {
  writePidFile()
  let shuttingDown = false
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(t('runner.shuttingDown'))
    removePidFile()
    updater?.stop()
    if (target.kind === 'processManager') {
      await target.processManager.stopAll()
    } else {
      // Each agent's stop() may be the graceful, draining `shutdown()` (see
      // runSingleProject's stopWithWatcher) — await it so process.exit() below
      // never fires while a command is still in flight.
      await Promise.all(target.agents.map((a) => a.stop()))
    }
    await flushSentry()
    logger.success(t('runner.stopped'))
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

function logMultiProjectStartup(
  projects: ProjectRegistration[],
  pollInterval: number,
  heartbeatInterval: number,
): void {
  logger.info(t('runner.startedMulti', { count: projects.length, pollInterval, heartbeatInterval }))
  for (const p of projects) {
    logger.info(`  - ${p.projectCode} (${p.apiUrl})`)
  }
  logger.info(t('runner.stopHint'))
}

function initAutoUpdater(
  options: RunnerOptions,
  config: { autoUpdate?: AutoUpdateConfig } | null | undefined,
  // 先頭のクライアントはハートビート送信にも使う。複数プロジェクトが同居する場合は
  // 全プロジェクトぶんを渡すこと（サーバー設定は全プロジェクトで有効なときだけ
  // 有効とみなすため。auto-update-gate.ts を参照）。
  clients: ApiClient[],
  agentId: string,
  stopAllAgents: () => void | Promise<void>,
  isAnyAgentBusy?: () => Promise<boolean>,
): AutoUpdaterHandle | undefined {
  const client = clients[0]
  if (!client) return undefined

  // CLI で明示的に無効化されていれば、サーバー設定でも覆せない。タイマー自体を作らない。
  if (options.autoUpdate === false) return undefined

  const autoUpdateConfig = resolveAutoUpdateConfig(options, config)
  const reportError = (error: string): void => {
    void client.heartbeat(agentId, getSystemInfo(), error).catch((err) => {
      logger.warn(`[auto-update] Failed to send error heartbeat: ${getErrorMessage(err)}`)
    })
  }

  // 実行可否そのものは更新チェックのたびに評価する（管理画面の変更を再起動なしで
  // 反映させるため）。ここで決めるのは「タイマーを持つかどうか」だけ。
  const isUpdateAllowed = createAutoUpdateGate({
    clients,
    cli: options.autoUpdate,
    local: config?.autoUpdate?.enabled,
  })

  // 自己更新が成立しない実行環境（Kubernetes、監督プロセスのいない PID 1）では、
  // 設定が有効でも起動しない。走らせると npm 更新 → プロセス終了 → コンテナ再作成で
  // イメージの版へ巻き戻る、を延々と繰り返すだけになるため。
  const capability = resolveSelfUpdateCapability()
  if (!capability.capable && capability.reason) {
    const message = describeSelfUpdateBlockReason(capability.reason)
    // 有効・無効に関わらず、なぜこの環境では動かないのかは起動時に1行残す。
    logger.info(`[auto-update] ${message}`)
    // 有効化されている場合だけ、警告とハートビートで管理画面にも理由を届ける。
    // 黙って無視すると「ONにしたのに更新されない」理由が誰にも見えなくなる。
    void isUpdateAllowed()
      .then((allowed) => {
        if (!allowed) return
        logger.warn(`[auto-update] ${message}`)
        reportError(message)
      })
      .catch((err: unknown) => {
        logger.debug(`[auto-update] Could not evaluate the auto-update setting: ${getErrorMessage(err)}`)
      })
    return undefined
  }

  return startAutoUpdater(
    clients,
    autoUpdateConfig,
    stopAllAgents,
    reportError,
    isAnyAgentBusy,
    isUpdateAllowed,
  )
}

export function resolveAutoUpdateConfig(options: RunnerOptions, config?: { autoUpdate?: AutoUpdateConfig } | null): AutoUpdateConfig {
  const detectedChannel = detectChannelFromVersion(AGENT_VERSION)
  return {
    autoRestart: true,
    channel: options.updateChannel ?? config?.autoUpdate?.channel ?? detectedChannel,
    ...config?.autoUpdate,
    // enabled はスプレッドのあとに置く。config.autoUpdate をそのまま展開すると
    // ローカル設定の enabled がそのまま残り、CLI フラグと既定 OFF の優先順位が
    // 効かなくなるため。サーバー設定は起動時点では取得できていないので
    // ここでは渡さず、更新チェックのたびに評価する（initAutoUpdater を参照）。
    enabled: resolveAutoUpdateEnablement({
      cli: options.autoUpdate,
      local: config?.autoUpdate?.enabled,
    }),
    ...(options.updateChannel && { channel: options.updateChannel }),
  }
}

function runSingleProject(
  project: ProjectRegistration,
  agentId: string,
  options: RunnerOptions,
  // ローカル設定。initAutoUpdater へそのまま渡す。以前ここが undefined 固定だったため、
  // --token / 環境変数起動（コンテナ経路）ではローカル設定の自動アップデート指定が
  // 一切効かず、CLI フラグでしか制御できなかった。
  config: { autoUpdate?: AutoUpdateConfig } | null | undefined,
  agentChatMode?: AgentChatMode,
  defaultProjectDir?: string,
  enableTokenWatcher = false,
): void {
  const { pollInterval, heartbeatInterval } = resolveIntervals(options)

  logger.info(t('runner.starting'))
  const started = startProjectAgent(project, agentId, { pollInterval, heartbeatInterval, agentChatMode, defaultProjectDir })

  // Use the graceful, draining shutdown() here too — not the synchronous
  // stop() — so an auto-update-triggered restart (self npm update) releases
  // the replica slot the same way SIGTERM/SIGINT and the reboot/update
  // commands do. Falling back to stop() would mean this restart path never
  // calls releaseSelf() and always falls back to the slower ~90s
  // heartbeat-timeout-based slot reclaim, and — if auto-updater.ts's busy-wait
  // times out while a command is still genuinely in flight — abandons that
  // command mid-flight, reintroducing the double-execution risk this feature
  // exists to close.
  const updater = initAutoUpdater(options, config, [started.client], agentId, () => started.agent.shutdown(), async () => started.agent.isBusy())

  let tokenWatcher: { stop: () => void } | undefined
  if (enableTokenWatcher) {
    tokenWatcher = startConfigWatcher([project], {
      onTokenUpdate: (_project, newToken) => {
        started.agent.updateToken(newToken)
      },
      onProjectAdded: () => {},
      onProjectRemoved: () => {},
    })
  }

  logger.info(t('runner.startedSingle', { pollInterval, heartbeatInterval }))
  logger.info(t('runner.stopHint'))

  // Graceful drain on shutdown (SIGTERM/SIGINT): use shutdown() rather than the
  // synchronous stop() so an in-flight command finishes before the replica
  // slot is released — otherwise the server could re-assign it to another
  // replica while this process is still executing it.
  const stopWithWatcher = async (): Promise<void> => {
    tokenWatcher?.stop()
    await started.agent.shutdown()
  }
  setupShutdownHandlers({ kind: 'agents', agents: [{ stop: stopWithWatcher }] }, updater)
}

export async function startAgent(options: RunnerOptions): Promise<void> {
  await initSentry()

  // 二重起動防止チェック
  if (isAlreadyRunning()) {
    const entry = readPidFile()
    exitWithError(`Agent is already running (PID: ${entry?.pid ?? '?'}). Use "ai-support-agent stop" to stop it first.`)
  }

  // グローバルエラーハンドラ（非同期エラーでの静かなクラッシュを防止）
  process.on('uncaughtException', (error) => {
    captureException(error, { handler: 'uncaughtException' })
    logger.error(`Uncaught exception: ${error.message}${error.stack ? `\n${error.stack}` : ''}`)
    void flushSentry().finally(() => process.exit(1))
  })
  process.on('unhandledRejection', (reason) => {
    captureException(reason, { handler: 'unhandledRejection' })
    logger.error(`Unhandled rejection: ${reason}`)
  })

  if (options.verbose) {
    logger.setVerbose(true)
  }

  // 起動時に古い terminal-sandbox ディレクトリを掃除する。
  // セッション終了時の cleanupTmpDir が SIGKILL / クラッシュで走らなかった
  // 場合に /tmp/terminal-sandbox-* が累積し、ENOSPC を引き起こすため。
  // 24 時間以上前のものだけを対象とし、現在稼働中の他 process の sandbox は
  // 触らない (mtime ベース)。
  try {
    const removed = TerminalSession.cleanupStaleSandboxes()
    if (removed > 0) {
      logger.info(`Cleaned up ${removed} stale terminal-sandbox dir(s) in /tmp`)
    }
  } catch (err: unknown) {
    logger.warn(`Failed to clean up stale terminal-sandbox dirs: ${getErrorMessage(err)}`)
  }

  // 起動時に古い server-setup ディレクトリを掃除する。SSH秘密鍵を含む
  // ため、terminal-sandbox と同じ理由（SIGKILL/クラッシュで finally が
  // 走らず孤立し、累積すると ENOSPC を引き起こす）で同じパターンを適用する。
  try {
    const removed = cleanupStaleServerSetupDirs()
    if (removed > 0) {
      logger.info(`Cleaned up ${removed} stale server-setup dir(s) in /tmp`)
    }
  } catch (err: unknown) {
    logger.warn(`Failed to clean up stale server-setup dirs: ${getErrorMessage(err)}`)
  }

  const config = loadConfig()

  // Environment variable support (lowest priority)
  const envToken = process.env[ENV_VARS.TOKEN]
  const envApiUrl = process.env[ENV_VARS.API_URL]

  // CLI args > config > env vars
  //
  // Direct start (no browser OAuth): an agent token or an agent-scoped Personal
  // Access Token (PAT) is passed on the command line. Triggered when --token is
  // combined with either --api-url (legacy agent-token flow) or --project (PAT
  // flow: `start --token <PAT> --project <tenantCode>/<projectCode>`). When
  // --api-url is omitted the production API URL is used.
  if (options.token && (options.apiUrl || options.project)) {
    const apiUrl = options.apiUrl ?? DEFAULT_API_URL
    const urlError = validateApiUrl(apiUrl)
    if (urlError) {
      exitWithError(urlError)
    }
    logger.warn(t('runner.cliTokenWarning'))

    // Derive tenantCode from the token; take projectCode from --project when given.
    // Reject a --project whose tenantCode does not match the token's tenantCode.
    const target = resolveDirectStartTarget(options.token, options.project, {
      tenantCode: 'unknown',
      projectCode: PROJECT_CODE_CLI_DIRECT,
    })
    if (!target.ok) {
      if (target.reason === 'tenant-mismatch') {
        exitWithError(
          t('runner.tokenProjectTenantMismatch', {
            tokenTenant: target.tokenTenantCode,
            projectTenant: target.projectTenantCode,
          }),
        )
      }
      // `resolveDirectStartTarget` only returns a non-ok result when a --project
      // was supplied, so it is guaranteed to be defined here.
      exitWithError(t('runner.projectFormatInvalid', { project: options.project as string }))
    }

    const agentId = extractTokenId(options.token) ?? config?.agentId ?? os.hostname()
    const project: ProjectRegistration = {
      tenantCode: target.tenantCode,
      projectCode: target.projectCode,
      token: options.token,
      apiUrl,
    }

    // Surface the resolved connection target so an accidental connection to the
    // production API (e.g. --api-url omitted → DEFAULT_API_URL) is visible in the
    // logs, matching how logMultiProjectStartup prints each project's apiUrl.
    if (!options.apiUrl) {
      logger.info(t('runner.directDefaultApiUrl', { apiUrl }))
    }
    logger.info(
      t('runner.directConnecting', {
        apiUrl,
        tenantCode: target.tenantCode,
        projectCode: target.projectCode,
      }),
    )

    runSingleProject(project, agentId, options, config, config?.agentChatMode, config?.defaultProjectDir)
    saveConfig({ lastConnected: nowIso() })
    return
  }

  // Multi-project config
  if (!config) {
    // Fall back to env vars if no config
    if (envToken && envApiUrl) {
      const envUrlError = validateApiUrl(envApiUrl)
      if (envUrlError) {
        exitWithError(envUrlError)
      }
      logger.info(t('runner.envTokenWarning'))

      // When --project is specified (e.g. from DockerSupervisor), use its tenantCode/projectCode
      let tenantCode = 'unknown'
      let projectCode = PROJECT_CODE_ENV_DEFAULT
      if (options.project) {
        const parsed = splitProjectRef(options.project)
        if (parsed) {
          tenantCode = parsed.tenantCode
          projectCode = parsed.projectCode
        }
      }

      const project: ProjectRegistration = {
        tenantCode,
        projectCode,
        token: envToken,
        apiUrl: envApiUrl,
      }

      // ここは `if (!config)` の内側なので、ローカル設定は存在しない（null を明示的に渡す）。
      runSingleProject(project, extractTokenId(envToken) ?? os.hostname(), options, null)
      return
    }

    exitWithError(t('runner.noToken'))
  }

  let projects = getProjectList(config)
  if (projects.length === 0) {
    exitWithError(t('runner.noProjects'))
  }

  // Filter to a single project when --project flag is specified (e.g. "mbc/PROJ_A")
  if (options.project) {
    const slashIdx = options.project.indexOf('/')
    if (slashIdx < 0) {
      exitWithError(`[runner] --project must be in "tenantCode/projectCode" format: ${options.project}`)
    }
    const tenantCode = options.project.substring(0, slashIdx)
    const projectCode = options.project.substring(slashIdx + 1)
    projects = projects.filter(
      (p) => p.tenantCode === tenantCode && p.projectCode === projectCode,
    )
    if (projects.length === 0) {
      exitWithError(`[runner] Project not found: ${options.project}`)
    }
  }

  // Each project's own token is bound (TOFU) to its own agentId server-side, so the
  // agentId sent for a project's WebSocket connections must be derived from that
  // project's own token, not shared across projects. If a token doesn't carry a
  // tokenId, projects fall back to the same config/hostname value and can hit the
  // same "Agent ID does not match the token binding" rejection this fix addresses,
  // so surface it instead of silently sharing the fallback.
  const resolveAgentId = (project: (typeof projects)[number]) => {
    const tokenId = extractTokenId(project.token)
    if (tokenId !== undefined) return tokenId
    logger.warn(
      `Could not extract tokenId from token for ${project.tenantCode}/${project.projectCode}; falling back to a shared agentId, which may cause "Agent ID does not match the token binding" errors if another project shares the same fallback`,
    )
    return config.agentId ?? os.hostname()
  }
  const forkAgentIds = projects.map(resolveAgentId)
  const agentId = forkAgentIds[0]
  const { pollInterval, heartbeatInterval } = resolveIntervals(options)

  logger.info(t('runner.startingMulti', { count: projects.length }))

  const forkOptions = {
    pollInterval,
    heartbeatInterval,
    agentChatMode: config.agentChatMode,
    defaultProjectDir: config.defaultProjectDir,
    verbose: options.verbose,
  }

  // Always use ChildProcessManager for dynamic project management
  const processManager = new ChildProcessManager()

  // In Docker mode, when a worker completes an update, exit the runner with
  // DOCKER_UPDATE_EXIT_CODE so the host-side runInDocker() rebuilds the image.
  if (isInDocker()) {
    processManager.onUpdateComplete = (project) => {
      logger.info(`[docker] Worker update complete (${project.tenantCode}/${project.projectCode}). Exiting container to rebuild image...`)
      void (async () => {
        await processManager.stopAll()
        process.exit(DOCKER_UPDATE_EXIT_CODE)
      })()
    }
  }

  projects.forEach((project, index) => {
    processManager.forkProject(project, forkAgentIds[index], forkOptions)
  })

  saveConfig({ lastConnected: nowIso() })

  // register を行わない通知専用クライアント（docker-runner と同じ理由で
  // レプリカ識別子を送らない）。
  //
  // 全プロジェクトぶんを作る。自動アップデートはホスト単位の操作なので、同居する
  // プロジェクトの1つでもサーバー設定で無効なら実行してはならない（auto-update-gate.ts）。
  // 先頭のクライアントはハートビート送信にも使われる。
  //
  // 1つでも生成できなければ自動アップデートを諦める（createAutoUpdateClients 参照）。
  // ApiClient のコンストラクタは HTTP の API URL 等で例外を投げるため、素直に map すると
  // 設定不備のプロジェクトが1つあるだけでエージェント全体の起動が落ちる。
  const clients = createAutoUpdateClients(
    projects,
    (apiUrl, token) => new ApiClient(apiUrl, token, { withoutReplicaIdentity: true }),
  )
  const updater = clients
    ? initAutoUpdater(options, config, clients, agentId, () => processManager.stopAll(), () => processManager.isAnyBusy())
    : undefined

  const configWatcher = startConfigWatcher(projects, {
    onTokenUpdate: (project, newToken) => {
      processManager.sendTokenUpdate(project, newToken)
    },
    onProjectAdded: (project) => {
      logger.info(`Hot-adding project: ${project.tenantCode}/${project.projectCode}`)
      processManager.forkProject(project, resolveAgentId(project), forkOptions)
    },
    onProjectRemoved: (project) => {
      logger.info(`Hot-removing project: ${project.tenantCode}/${project.projectCode}`)
      void processManager.stopProject(project)
    },
  })

  logMultiProjectStartup(projects, pollInterval, heartbeatInterval)
  setupShutdownHandlers({ kind: 'processManager', processManager }, updater)

  // Clean up config watcher on shutdown
  const origStopAll = processManager.stopAll.bind(processManager)
  processManager.stopAll = async (timeoutMs?: number): Promise<void> => {
    configWatcher.stop()
    await origStopAll(timeoutMs)
  }
}
