import { existsSync } from 'fs'
import { join, resolve } from 'path'

import type { ApiClient } from './api-client'
import { detectAvailableChatModes, resolveActiveChatMode } from './chat-mode-detector'
import { CONFIG_SYNC_DEBOUNCE_MS } from './constants'
import { logger } from './logger'
import { writeAwsConfig } from './aws-profile'
import { writeMcpConfig } from './mcp/config-writer'
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
  mcpConfigPath: string | undefined
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
}

/**
 * Perform config sync from server and update state.
 * Returns true if config was updated.
 */
export async function performConfigSync(
  deps: ConfigSyncDeps,
  state: ConfigSyncState,
): Promise<boolean> {
  const config = await syncProjectConfig(
    deps.client,
    state.currentConfigHash,
    deps.projectDir,
    deps.prefix,
  )
  if (config) {
    await applyProjectConfig(deps, state, config)
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

/**
 * Apply project config to state (update serverConfig, write AWS/MCP config files).
 */
export async function applyProjectConfig(
  deps: ConfigSyncDeps,
  state: ConfigSyncState,
  config: ProjectConfigResponse,
): Promise<void> {
  state.currentConfigHash = config.configHash
  state.projectConfig = config

  // Update serverConfig from project config
  state.serverConfig = {
    agentEnabled: config.agent.agentEnabled,
    builtinAgentEnabled: config.agent.builtinAgentEnabled,
    builtinFallbackEnabled: config.agent.builtinFallbackEnabled,
    externalAgentEnabled: config.agent.externalAgentEnabled,
    chatMode: 'agent',
    claudeCodeConfig: {
      allowedTools: config.agent.allowedTools,
      addDirs: config.agent.claudeCodeConfig?.additionalDirs,
      systemPrompt: config.agent.claudeCodeConfig?.appendSystemPrompt,
    },
  }

  // Write AWS config file if project directory and AWS accounts are configured
  if (deps.projectDir && config.aws?.accounts?.length) {
    try {
      writeAwsConfig(deps.projectDir, config.project.projectCode, config.aws.accounts)
    } catch (error) {
      logger.warn(`${deps.prefix} Failed to write AWS config: ${getErrorMessage(error)}`)
    }
  }

  // Log database configuration
  if (config.databases?.length) {
    logger.info(`${deps.prefix} Databases configured: ${config.databases.map(db => `${db.name}(${db.engine})`).join(', ')}`)
  }

  // Log repository configuration
  if (config.repositories?.length) {
    logger.info(`${deps.prefix} Repositories configured: ${config.repositories.map(r => `${r.repositoryName}(${r.provider})`).join(', ')}`)
  }

  // Write MCP config file if project directory is available
  if (deps.projectDir) {
    try {
      const mcpServerPath = resolveMcpServerPath()
      const backlogConfigs = config.backlog?.items?.map((item) => ({
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
    } catch (error) {
      logger.warn(`${deps.prefix} Failed to write MCP config: ${getErrorMessage(error)}`)
    }
  }

  // Set up SSH config if SSH hosts are configured and project directory is available
  if (config.ssh?.enabled && config.ssh.hosts?.length && deps.projectDir) {
    try {
      const sshDir = getSshDir(deps.projectDir)
      await setupSshConfig(deps.client, config.ssh, sshDir)
    } catch (error) {
      logger.warn(`${deps.prefix} Failed to set up SSH config: ${getErrorMessage(error)}`)
    }
  }

  logger.info(`${deps.prefix} Config applied (hash: ${config.configHash})`)
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
        logger.debug(`${deps.prefix} claudeCodeConfig: allowedTools=[${state.serverConfig.claudeCodeConfig.allowedTools?.join(', ') ?? ''}], addDirs=[${state.serverConfig.claudeCodeConfig.addDirs?.join(', ') ?? ''}]`)
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
  if (verbose) {
    logger.info(`${deps.prefix} Active chat mode: ${state.activeChatMode ?? 'none'}`)
  }
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
