import { TOKEN_WATCH_INTERVAL_MS } from './constants'
import { loadConfig, getProjectList } from './config-manager'
import { logger } from './logger'
import type { ProjectRegistration } from './types'

export interface ConfigWatcherCallbacks {
  onTokenUpdate: (projectCode: string, newToken: string) => void
  onProjectAdded: (project: ProjectRegistration) => void
  onProjectRemoved: (projectCode: string) => void
}

/**
 * config.json を定期的にポーリングし、プロジェクトの追加・削除・トークン変更を検知する。
 *
 * - トークン変更: 既存プロジェクトのトークンが変わった場合
 * - プロジェクト追加: config に新しいプロジェクトが追加された場合
 * - プロジェクト削除: config からプロジェクトが削除された場合
 */
export function startConfigWatcher(
  initialProjects: ProjectRegistration[],
  callbacks: ConfigWatcherCallbacks,
): { stop: () => void } {
  const currentProjects = new Map<string, ProjectRegistration>()
  for (const p of initialProjects) {
    currentProjects.set(p.projectCode, { ...p })
  }

  const timer = setInterval(() => {
    try {
      const config = loadConfig()
      if (!config) return

      const configProjects = getProjectList(config)
      const configProjectCodes = new Set<string>()

      for (const cp of configProjects) {
        configProjectCodes.add(cp.projectCode)

        const existing = currentProjects.get(cp.projectCode)
        if (!existing) {
          // New project added
          logger.info(`Config watcher: new project detected: ${cp.projectCode}`)
          currentProjects.set(cp.projectCode, { ...cp })
          callbacks.onProjectAdded(cp)
        } else if (cp.token !== existing.token) {
          // Token changed
          logger.debug(`Config watcher: token changed for ${cp.projectCode}`)
          currentProjects.set(cp.projectCode, { ...cp })
          callbacks.onTokenUpdate(cp.projectCode, cp.token)
        }
      }

      // Detect removed projects
      for (const projectCode of currentProjects.keys()) {
        if (!configProjectCodes.has(projectCode)) {
          logger.info(`Config watcher: project removed: ${projectCode}`)
          currentProjects.delete(projectCode)
          callbacks.onProjectRemoved(projectCode)
        }
      }
    } catch {
      // Config may be in the middle of being written; ignore read errors
    }
  }, TOKEN_WATCH_INTERVAL_MS)

  return {
    stop: () => clearInterval(timer),
  }
}

/**
 * Legacy wrapper: token-only watcher (backwards compatibility for startTokenWatcher imports)
 */
export function startTokenWatcher(
  projects: ProjectRegistration[],
  onTokenUpdate: (projectCode: string, newToken: string) => void,
): { stop: () => void } {
  return startConfigWatcher(projects, {
    onTokenUpdate,
    onProjectAdded: () => {},
    onProjectRemoved: () => {},
  })
}
