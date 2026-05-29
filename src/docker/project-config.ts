/**
 * Per-project config directory management
 *
 * Handles migration from legacy layout and path resolution.
 */

import * as fs from 'fs'
import * as path from 'path'

import { getConfigDir } from '../config-manager'
import { logger } from '../logger'
import type { ProjectRegistration } from '../types'
import { getErrorMessage } from '../utils'

/**
 * Get the host-side per-project config directory.
 * Located at: ~/.ai-support-agent/projects/{tenantCode}/{projectCode}/.ai-support-agent/
 */
export function getProjectConfigHostDir(project: ProjectRegistration): string {
  return path.join(getConfigDir(), 'projects', project.tenantCode, project.projectCode, '.ai-support-agent')
}

/**
 * Migrate per-project config directory from the legacy layout to the current layout.
 *
 * Legacy: ~/.ai-support-agent/projects/{projectCode}/
 * Current: ~/.ai-support-agent/projects/{tenantCode}/{projectCode}/
 *
 * Older agent versions stored project data without a tenantCode path segment.
 * This function moves the directory once so the current code finds it in the right place.
 */
export function migrateProjectConfigDir(project: ProjectRegistration): void {
  const configBase = path.join(getConfigDir(), 'projects')
  const legacyDir = path.join(configBase, project.projectCode)
  const newDir = path.join(configBase, project.tenantCode, project.projectCode)

  if (!fs.existsSync(legacyDir)) return       // nothing to migrate
  if (fs.existsSync(newDir)) return            // already migrated

  try {
    fs.mkdirSync(path.join(configBase, project.tenantCode), { recursive: true, mode: 0o700 })
    fs.renameSync(legacyDir, newDir)
    logger.info(`[docker] Migrated project config dir: ${legacyDir} → ${newDir}`)
  } catch (err: unknown) {
    logger.warn(`[docker] Failed to migrate project config dir for ${project.projectCode}: ${getErrorMessage(err)}`)
  }
}
