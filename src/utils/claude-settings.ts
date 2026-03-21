import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { logger } from '../logger'

/**
 * Update ~/.claude/settings.json to allow the specified tools.
 *
 * Claude Code CLI requires tools to be listed in settings.json permissions.allow
 * for them to execute without interactive confirmation in print mode (-p).
 * This is especially needed for tools like WebFetch and WebSearch.
 *
 * Only adds tools that are not already in the allow list.
 * Never removes existing permissions.
 */
export function ensureAllowedToolsInSettings(allowedTools: string[]): void {
  if (allowedTools.length === 0) return

  try {
    const claudeDir = path.join(os.homedir(), '.claude')
    const settingsPath = path.join(claudeDir, 'settings.json')

    // Ensure .claude directory exists
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true, mode: 0o700 })
    }

    // Read existing settings
    let settings: Record<string, unknown> = {}
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
      } catch {
        logger.warn('[claude-settings] settings.json is corrupted, resetting permissions')
      }
    }

    // Ensure permissions.allow exists
    if (!settings.permissions || typeof settings.permissions !== 'object') {
      settings.permissions = {}
    }
    const permissions = settings.permissions as Record<string, unknown>

    if (!Array.isArray(permissions.allow)) {
      permissions.allow = []
    }
    const allowList = permissions.allow as string[]

    // Add missing tools
    let modified = false
    for (const tool of allowedTools) {
      if (!allowList.includes(tool)) {
        allowList.push(tool)
        modified = true
      }
    }

    if (modified) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })
      logger.debug(`[claude-settings] Updated permissions.allow: ${allowList.join(', ')}`)
    }
  } catch (error) {
    logger.warn(`[claude-settings] Failed to update settings.json: ${error instanceof Error ? error.message : String(error)}`)
  }
}
