import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { join, resolve } from 'path'

import type { ApiClient } from './api-client'
import { detectAvailableChatModes, resolveActiveChatMode } from './chat-mode-detector'
import { CONFIG_SYNC_DEBOUNCE_MS } from './constants'
import { logger } from './logger'
import { writeAwsConfig } from './aws-profile'
import { cleanupStaleCommandMcpConfigs, writeMcpConfig } from './mcp/config-writer'
import { getReposDir, getSshDir } from './project-dir'
import { syncProjectConfig } from './project-config-sync'
import { syncRepositories, syncRepositoryByCode } from './repo-sync'
import type { RepoSyncResult } from './repo-sync'
import { setupSshConfig } from './ssh-config-setup'
import type { AgentChatMode, AgentServerConfig, ProjectConfigResponse } from './types'
import { getErrorMessage } from './utils'

export interface ConfigSyncState {
  currentConfigHash: string | undefined
  projectConfig: ProjectConfigResponse | undefined
  serverConfig: AgentServerConfig | null
  availableChatModes: AgentChatMode[]
  activeChatMode: AgentChatMode | undefined
  activeChatModeExplicit: boolean
  mcpConfigPath: string | undefined
  dockerCustomizationHash: string | undefined
}

export interface ConfigSyncDeps {
  client: ApiClient
  prefix: string
  projectDir: string | undefined
  apiUrl: string
  token: string
  projectCode: string
  localAgentChatMode: AgentChatMode | undefined
  browserLocalPort?: number
  /** Called when Docker customization changes (Docker mode only) */
  onDockerRebuild?: () => void
}

/**
 * Perform config sync from server and update state.
 * Returns true if config was updated.
 */
export async function performConfigSync(
  deps: ConfigSyncDeps,
  state: ConfigSyncState,
): Promise<boolean> {
  const result = await syncProjectConfig(
    deps.client,
    state.currentConfigHash,
    deps.projectDir,
    deps.prefix,
  )
  if (result) {
    await applyProjectConfig(deps, state, result.config, { fromCache: result.fromCache })
    return true
  }
  return false
}

/**
 * Perform full setup: config sync + repository sync + documentation check.
 */
export async function performSetup(
  deps: ConfigSyncDeps,
  state: ConfigSyncState,
): Promise<void> {
  logger.info(`${deps.prefix} Starting setup...`)

  // 1. Config sync
  await performConfigSync(deps, state)

  // 2. Clone/update repositories
  if (deps.projectDir && state.projectConfig?.repositories?.length) {
    try {
      const reposDir = getReposDir(deps.projectDir)
      const results = await syncRepositories(
        deps.client,
        state.projectConfig.repositories,
        reposDir,
        deps.prefix,
      )
      const cloned = results.filter(r => r.status === 'cloned').length
      const updated = results.filter(r => r.status === 'updated').length
      const skipped = results.filter(r => r.status === 'skipped').length
      logger.info(`${deps.prefix} Repository sync: ${cloned} cloned, ${updated} updated, ${skipped} skipped`)
    } catch (error) {
      logger.warn(`${deps.prefix} Repository sync failed: ${getErrorMessage(error)}`)
    }
  }

  // 3. Download documentation
  if (state.projectConfig?.documentation?.sources) {
    logger.info(`${deps.prefix} Documentation sources found: ${state.projectConfig.documentation.sources.length}`)
    // Documentation download will be implemented in a future phase
  }

  logger.info(`${deps.prefix} Setup completed`)
}

/** Options for applyProjectConfig */
export interface ApplyProjectConfigOptions {
  /**
   * `true` のとき、`config` はディスクキャッシュから復元したもので、
   * 秘匿情報 (envVars 等) が抜けている可能性がある。
   * 直前まで適用していた envVars を保持してネットワーク断時の劣化を防ぐ。
   */
  fromCache?: boolean
}

/**
 * Apply project config to state (update serverConfig, write AWS/MCP config files).
 */
export async function applyProjectConfig(
  deps: ConfigSyncDeps,
  state: ConfigSyncState,
  config: ProjectConfigResponse,
  options: ApplyProjectConfigOptions = {},
): Promise<void> {
  // キャッシュフォールバック中は envVars が抜けているため、前回値を保持する
  // （Web で設定された ANTHROPIC_API_KEY 等が一時的なネットワーク断で消えるのを防ぐ）
  // null/undefined どちらも『キャッシュに envVars 無し』とみなす。
  const previousEnvVars = state.projectConfig?.envVars
  let effectiveConfig = config
  if (options.fromCache && config.envVars == null) {
    if (previousEnvVars) {
      logger.warn(
        `${deps.prefix} Config restored from cache; preserving last-known envVars (${Object.keys(previousEnvVars).length} keys)`,
      )
      // shallow copy で previousEnvVars と state を切り離す（後続変更による副作用を防ぐ）
      effectiveConfig = { ...config, envVars: { ...previousEnvVars } }
    } else {
      // 起動直後にネットワーク断でキャッシュからロードした場合、前回値も無い
      // → Web 設定 (CLAUDE_CODE#API_KEY 等) が次回 sync まで効かないことを明示
      logger.warn(
        `${deps.prefix} Config restored from cache and no previous envVars in memory; ` +
          `Web-configured env overrides (CLAUDE_CODE#* / ENV#*) will be unavailable ` +
          `until the next successful network sync`,
      )
    }
  }

  state.currentConfigHash = effectiveConfig.configHash
  state.projectConfig = effectiveConfig

  // Update serverConfig from project config
  state.serverConfig = {
    agentEnabled: effectiveConfig.agent.agentEnabled,
    builtinAgentEnabled: effectiveConfig.agent.builtinAgentEnabled,
    builtinFallbackEnabled: effectiveConfig.agent.builtinFallbackEnabled,
    externalAgentEnabled: effectiveConfig.agent.externalAgentEnabled,
    chatMode: 'agent',
    agentChatModeOverrides: effectiveConfig.agent.agentChatModeOverrides,
    claudeCodeConfig: {
      allowedTools: effectiveConfig.agent.allowedTools,
      addDirs: effectiveConfig.agent.claudeCodeConfig?.additionalDirs,
      systemPrompt: effectiveConfig.agent.claudeCodeConfig?.appendSystemPrompt,
      model: effectiveConfig.agent.claudeCodeConfig?.model,
    },
    codexConfig: effectiveConfig.agent.codexConfig
      ? {
          addDirs: effectiveConfig.agent.codexConfig.additionalDirs,
          systemPrompt: effectiveConfig.agent.codexConfig.appendSystemPrompt,
          model: effectiveConfig.agent.codexConfig.model,
        }
      : undefined,
  }

  // Write AWS config file if project directory and AWS accounts are configured
  if (deps.projectDir && effectiveConfig.aws?.accounts?.length) {
    try {
      writeAwsConfig(deps.projectDir, effectiveConfig.project.projectCode, effectiveConfig.aws.accounts)
    } catch (error) {
      logger.warn(`${deps.prefix} Failed to write AWS config: ${getErrorMessage(error)}`)
    }
  }

  // Log database configuration
  if (effectiveConfig.databases?.length) {
    logger.info(`${deps.prefix} Databases configured: ${effectiveConfig.databases.map(db => `${db.name}(${db.engine})`).join(', ')}`)
  }

  // Log repository configuration
  if (effectiveConfig.repositories?.length) {
    logger.info(`${deps.prefix} Repositories configured: ${effectiveConfig.repositories.map(r => `${r.repositoryName}(${r.provider})`).join(', ')}`)
  }

  // Write MCP config file if project directory is available
  if (deps.projectDir) {
    try {
      const mcpServerPath = resolveMcpServerPath()
      const backlogConfigs = effectiveConfig.backlog?.items?.map((item) => ({
        domain: item.domain,
        apiKey: item.apiKey,
      }))
      state.mcpConfigPath = writeMcpConfig(
        deps.projectDir,
        deps.apiUrl,
        deps.token,
        deps.projectCode,
        mcpServerPath,
        backlogConfigs,
        undefined,
        deps.browserLocalPort,
      )
      logger.info(`${deps.prefix} MCP config written: ${state.mcpConfigPath}`)

      // 孤立した per-command MCP 設定ファイル（config-*.json）を掃除する。
      // 通常は chat-executor.ts がコマンド完了時に削除するが、agent process が
      // SIGKILL / OOM で異常終了すると平文トークン・conversationId を含むファイルが
      // 残り続ける。config sync のたびに実行することで自己修復する
      // （TerminalSession.cleanupStaleSandboxes と同じ設計）。
      try {
        const removedCount = cleanupStaleCommandMcpConfigs(state.mcpConfigPath)
        if (removedCount > 0) {
          logger.info(`${deps.prefix} Cleaned up ${removedCount} stale per-command MCP config file(s)`)
        }
      } catch (error) {
        logger.warn(`${deps.prefix} Failed to clean up stale per-command MCP config files: ${getErrorMessage(error)}`)
      }
    } catch (error) {
      logger.warn(`${deps.prefix} Failed to write MCP config: ${getErrorMessage(error)}`)
    }
  }

  // Set up SSH config if SSH hosts are configured and project directory is available
  if (effectiveConfig.ssh?.enabled && effectiveConfig.ssh.hosts?.length && deps.projectDir) {
    try {
      const sshDir = getSshDir(deps.projectDir)
      await setupSshConfig(deps.client, effectiveConfig.ssh, sshDir)
    } catch (error) {
      logger.warn(`${deps.prefix} Failed to set up SSH config: ${getErrorMessage(error)}`)
    }
  }

  // envVars override（CLAUDE_CODE# / ENV# from Web 設定）— spawn 時に注入
  // 注: API モード (executeApiChatCommand) はこの envVars を参照しない。
  //     CLI モード (claude_code / codex) でのみ spawn 時に env として注入される。
  // ログ方針: キー集合だけでなく値のハッシュも比較し、value rotation も検知する。
  // 全消去 (non-empty → empty) も明示的にログに残す。
  const previousSignature = computeEnvVarsSignature(previousEnvVars)
  const newSignature = computeEnvVarsSignature(effectiveConfig.envVars)
  if (previousSignature !== newSignature) {
    if (effectiveConfig.envVars && Object.keys(effectiveConfig.envVars).length > 0) {
      const overriddenKeys = Object.keys(effectiveConfig.envVars).sort()
      logger.info(`${deps.prefix} envVars override updated: ${overriddenKeys.join(', ')}`)
    } else if (previousEnvVars && Object.keys(previousEnvVars).length > 0) {
      logger.info(`${deps.prefix} envVars override cleared (no Web-configured env vars)`)
    }
  }

  // Detect Docker customization changes and trigger rebuild if needed
  if (deps.onDockerRebuild) {
    const newDockerHash = createHash('md5').update(JSON.stringify(effectiveConfig.agent.dockerCustomization ?? null)).digest('hex')
    const noCustomizationHash = createHash('md5').update(JSON.stringify(null)).digest('hex')
    const prevDockerHash = state.dockerCustomizationHash
    // Trigger rebuild if:
    // - Hash changed (includes first sync where prevDockerHash is undefined)
    // - AND new config has actual packages (not null/empty)
    // This ensures containers always rebuild on startup when packages are configured.
    if (prevDockerHash !== newDockerHash && newDockerHash !== noCustomizationHash) {
      logger.info(`${deps.prefix} Docker customization changed, triggering rebuild...`)
      deps.onDockerRebuild()
    }
    state.dockerCustomizationHash = newDockerHash
  }

  logger.info(`${deps.prefix} Config applied (hash: ${effectiveConfig.configHash})`)
}

/**
 * envVars マップの内容を表す安定文字列を返す。
 * キーをソートして value も含めて連結することで、キー追加/削除だけでなく
 * 値の rotation も検知できるシグネチャになる。
 */
function computeEnvVarsSignature(envVars: Record<string, string> | undefined): string {
  if (!envVars) return ''
  const sortedKeys = Object.keys(envVars).sort()
  return sortedKeys.map((k) => `${k}=${envVars[k]}`).join('\n')
}

export interface SyncRepositoryOptions {
  repositoryCode: string
  branch?: string
}

/**
 * 特定リポジトリをコードとブランチ指定で同期する。
 */
export async function performSyncRepository(
  deps: ConfigSyncDeps,
  state: ConfigSyncState,
  options: SyncRepositoryOptions,
): Promise<RepoSyncResult> {
  if (!deps.projectDir) {
    throw new Error('Project directory is required for sync_repository')
  }
  if (!state.projectConfig) {
    throw new Error('Project config not loaded')
  }
  if (!state.projectConfig.repositories?.length) {
    throw new Error('No repositories configured')
  }
  const reposDir = getReposDir(deps.projectDir)
  const result = await syncRepositoryByCode(
    deps.client,
    state.projectConfig.repositories,
    options.repositoryCode,
    options.branch,
    reposDir,
    deps.prefix,
  )
  logger.info(`${deps.prefix} Repository synced: ${result.repositoryName} (${result.status})`)
  return result
}

/**
 * Schedule a debounced config sync.
 * Returns the new timer handle (caller should store it and clear on stop).
 */
export function scheduleConfigSync(
  deps: ConfigSyncDeps,
  state: ConfigSyncState,
  existingTimer: ReturnType<typeof setTimeout> | null,
): ReturnType<typeof setTimeout> {
  if (existingTimer) {
    clearTimeout(existingTimer)
  }
  return setTimeout(() => {
    void performConfigSync(deps, state)
  }, CONFIG_SYNC_DEBOUNCE_MS)
}

/**
 * Refresh available chat modes and server config.
 */
export async function refreshChatMode(
  deps: ConfigSyncDeps,
  state: ConfigSyncState,
  verbose: boolean,
): Promise<void> {
  state.availableChatModes = await detectAvailableChatModes()
  if (verbose) {
    logger.info(`${deps.prefix} Available chat modes: ${JSON.stringify(state.availableChatModes)}`)
  }

  try {
    state.serverConfig = await deps.client.getConfig()
    if (verbose) {
      logger.info(`${deps.prefix} Server config loaded: chatMode=${state.serverConfig.chatMode}`)
      if (state.serverConfig.claudeCodeConfig) {
        logger.debug(`${deps.prefix} claudeCodeConfig: allowedTools=[${state.serverConfig.claudeCodeConfig.allowedTools?.join(', ') ?? ''}], addDirs=[${state.serverConfig.claudeCodeConfig.addDirs?.join(', ') ?? ''}], model=${state.serverConfig.claudeCodeConfig.model ?? ''}`)
      }
    }
  } catch (error) {
    if (verbose) {
      logger.warn(`${deps.prefix} Failed to load server config, using defaults: ${getErrorMessage(error)}`)
    }
  }

  state.activeChatMode = resolveActiveChatMode(
    state.availableChatModes,
    deps.localAgentChatMode,
    state.serverConfig?.defaultAgentChatMode,
  )
  state.activeChatModeExplicit = isExplicitChatModeSelection(
    state.availableChatModes,
    deps.localAgentChatMode,
    state.serverConfig?.defaultAgentChatMode,
  )
  if (verbose) {
    logger.info(`${deps.prefix} Active chat mode: ${state.activeChatMode ?? 'none'}`)
  }
}

function isExplicitChatModeSelection(
  availableChatModes: AgentChatMode[],
  localAgentChatMode: AgentChatMode | undefined,
  defaultAgentChatMode: AgentChatMode | undefined,
): boolean {
  return (
    (localAgentChatMode !== undefined && availableChatModes.includes(localAgentChatMode)) ||
    (defaultAgentChatMode !== undefined && availableChatModes.includes(defaultAgentChatMode))
  )
}

/**
 * MCP server script path resolution.
 *
 * When running with ts-node/tsx, __dirname points to src/ where server.js does not exist.
 * In that case, fall back to dist/mcp/server.js.
 */
export function resolveMcpServerPath(): string {
  const candidate = join(__dirname, 'mcp', 'server.js')
  if (existsSync(candidate)) return candidate

  // ts-node: src/ -> dist/
  const distCandidate = resolve(__dirname, '..', 'dist', 'mcp', 'server.js')
  if (existsSync(distCandidate)) return distCandidate

  logger.warn(`[mcp] MCP server script not found at ${candidate} or ${distCandidate}`)
  return candidate
}
