import * as fs from 'fs'
import * as path from 'path'

import type { ApiClient } from './api-client'
import { getCacheDir } from './project-dir'
import { logger } from './logger'
import type { CachedProjectConfig, ProjectConfigResponse } from './types'
import { atomicWriteFile } from './utils'

const CACHE_FILE_NAME = 'project-config.json'

/**
 * Sync project config from server.
 * Returns the config if it was updated (different hash), or null if unchanged.
 */
export async function syncProjectConfig(
  client: ApiClient,
  currentHash: string | undefined,
  projectDir: string | undefined,
  prefix: string,
): Promise<ProjectConfigResponse | null> {
  try {
    const config = await client.getProjectConfig()

    if (config.configHash === currentHash) {
      logger.debug(`${prefix} Config unchanged (hash: ${config.configHash})`)
      return null
    }

    logger.info(`${prefix} Config updated: ${currentHash ?? 'none'} -> ${config.configHash}`)

    if (projectDir) {
      saveCachedConfig(projectDir, config)
    }

    return config
  } catch (error) {
    logger.warn(`${prefix} Failed to sync project config: ${error}`)

    // Try loading from cache on failure
    if (projectDir) {
      const cached = loadCachedConfig(projectDir)
      if (cached && cached.configHash !== currentHash) {
        logger.info(`${prefix} Using cached config (hash: ${cached.configHash})`)
        const { configHash: _hash, ...rest } = cached.config
        return {
          configHash: cached.configHash,
          ...rest,
        } as ProjectConfigResponse
      }
    }

    return null
  }
}

/**
 * Save project config to cache (excluding AWS credentials).
 * Uses atomic write (temp + rename) with 0o600 permissions.
 */
export function saveCachedConfig(
  projectDir: string,
  config: ProjectConfigResponse,
): void {
  try {
    const cacheDir = getCacheDir(projectDir)
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    }

    const cacheData: CachedProjectConfig = {
      cachedAt: new Date().toISOString(),
      configHash: config.configHash,
      config: {
        configHash: config.configHash,
        project: config.project,
        agent: config.agent,
        documentation: config.documentation,
        // aws is intentionally excluded from cache
      },
    }

    const cachePath = path.join(cacheDir, CACHE_FILE_NAME)
    atomicWriteFile(cachePath, JSON.stringify(cacheData, null, 2))

    logger.debug(`Config cached to ${cachePath}`)
  } catch (error) {
    logger.warn(`Failed to save config cache: ${error}`)
  }
}

/**
 * Load cached project config.
 * Returns null if cache doesn't exist or is corrupted.
 */
export function loadCachedConfig(
  projectDir: string,
): CachedProjectConfig | null {
  try {
    const cachePath = path.join(getCacheDir(projectDir), CACHE_FILE_NAME)
    if (!fs.existsSync(cachePath)) {
      return null
    }
    const data = fs.readFileSync(cachePath, 'utf-8')
    return JSON.parse(data) as CachedProjectConfig
  } catch {
    return null
  }
}
