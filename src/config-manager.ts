import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'

import { CONFIG_DIR, CONFIG_FILE, PROJECT_CODE_DEFAULT } from './constants'
import { t } from './i18n'
import { logger } from './logger'
import type { AgentConfig, LegacyAgentConfig, ProjectRegistration } from './types'

function getConfigDir(): string {
  return path.join(os.homedir(), CONFIG_DIR)
}

function getConfigPath(): string {
  return path.join(getConfigDir(), CONFIG_FILE)
}

function writeConfigFile(configPath: string, data: AgentConfig): void {
  const tmpPath = configPath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  fs.renameSync(tmpPath, configPath)
}

function generateAgentId(): string {
  const hostname = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, '-')
  const randomHex = crypto.randomBytes(8).toString('hex')
  return `${hostname}-${randomHex}`
}

/**
 * Migrate legacy single-token config to multi-project format.
 * Returns migrated config if migration was performed, otherwise returns as-is.
 */
function migrateConfigIfNeeded(raw: LegacyAgentConfig): AgentConfig {
  if (raw.token && raw.apiUrl && (!raw.projects || raw.projects.length === 0)) {
    logger.info(t('config.migrating'))
    const migrated: AgentConfig = {
      agentId: raw.agentId,
      createdAt: raw.createdAt,
      lastConnected: raw.lastConnected,
      language: raw.language,
      projects: [{
        projectCode: PROJECT_CODE_DEFAULT,
        token: raw.token,
        apiUrl: raw.apiUrl,
      }],
    }
    const configPath = getConfigPath()
    writeConfigFile(configPath, migrated)
    logger.success(t('config.migrated'))
    return migrated
  }
  return raw
}

export function loadConfig(): AgentConfig | null {
  const configPath = getConfigPath()
  try {
    if (!fs.existsSync(configPath)) {
      return null
    }
    const data = fs.readFileSync(configPath, 'utf-8')
    const raw = JSON.parse(data) as LegacyAgentConfig
    return migrateConfigIfNeeded(raw)
  } catch (error) {
    logger.warn(t('config.readError', { error: String(error) }))
    return null
  }
}

export function saveConfig(config: Partial<AgentConfig>): void {
  const configDir = getConfigDir()
  if (fs.existsSync(configDir)) {
    fs.chmodSync(configDir, 0o700)
  } else {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  }

  const existing = loadConfig()
  const merged: AgentConfig = {
    agentId: config.agentId ?? existing?.agentId ?? generateAgentId(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastConnected: config.lastConnected ?? existing?.lastConnected,
    language: config.language ?? existing?.language,
    projects: config.projects ?? existing?.projects,
  }

  const configPath = getConfigPath()
  writeConfigFile(configPath, merged)
  logger.debug(t('config.savedDebug', { path: configPath }))
}

export function getOrCreateAgentId(): string {
  const config = loadConfig()
  if (config?.agentId) {
    return config.agentId
  }
  const agentId = generateAgentId()
  saveConfig({ agentId })
  return agentId
}

export function clearConfig(): void {
  const configPath = getConfigPath()
  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath)
  }
}

/**
 * Add a project (upsert by projectCode)
 */
export function addProject(registration: ProjectRegistration): void {
  const config = loadConfig()
  const projects = config?.projects ?? []
  const existing = projects.findIndex(
    (p) => p.projectCode === registration.projectCode,
  )
  if (existing >= 0) {
    projects[existing] = registration
  } else {
    projects.push(registration)
  }
  saveConfig({ projects })
}

/**
 * Remove a project by code
 */
export function removeProject(projectCode: string): boolean {
  const config = loadConfig()
  const projects = config?.projects ?? []
  const filtered = projects.filter((p) => p.projectCode !== projectCode)
  if (filtered.length === projects.length) {
    return false
  }
  saveConfig({ projects: filtered })
  return true
}

/**
 * Get registered project list
 */
export function getProjectList(
  config: AgentConfig,
): ProjectRegistration[] {
  return config.projects ?? []
}
