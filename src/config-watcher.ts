import { TOKEN_WATCH_INTERVAL_MS } from './constants'
import { loadConfig, getProjectList } from './config-manager'
import { logger } from './logger'
import { projectKey } from './project-key'
import type { ProjectRegistration } from './types'
import { getErrorMessage } from './utils'

export interface ConfigWatcherCallbacks {
  onTokenUpdate: (project: ProjectRegistration, newToken: string) => void
  onProjectAdded: (project: ProjectRegistration) => void
  onProjectRemoved: (project: ProjectRegistration) => void
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
    currentProjects.set(projectKey(p), { ...p })
  }

  const timer = setInterval(() => {
    try {
      const config = loadConfig()
      if (!config) return

      const configProjects = getProjectList(config)
      const configKeys = new Set<string>()

      for (const cp of configProjects) {
        const key = projectKey(cp)
        configKeys.add(key)

        const existing = currentProjects.get(key)
        if (!existing) {
          // New project added
          logger.info(`Config watcher: new project detected: ${key}`)
          currentProjects.set(key, { ...cp })
          callbacks.onProjectAdded(cp)
        } else if (cp.token !== existing.token) {
          // Token changed
          logger.debug(`Config watcher: token changed for ${key}`)
          currentProjects.set(key, { ...cp })
          callbacks.onTokenUpdate(cp, cp.token)
        }
      }

      // Detect removed projects
      for (const [key, project] of currentProjects) {
        if (!configKeys.has(key)) {
          logger.info(`Config watcher: project removed: ${key}`)
          currentProjects.delete(key)
          callbacks.onProjectRemoved(project)
        }
      }
    } catch (err: unknown) {
      // Config may be in the middle of being written; only warn on unexpected errors
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') return
      logger.warn(`[config-watcher] Error reading config: ${getErrorMessage(err)}`)
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
  onTokenUpdate: (project: ProjectRegistration, newToken: string) => void,
): { stop: () => void } {
  return startConfigWatcher(projects, {
    onTokenUpdate,
    onProjectAdded: () => {},
    onProjectRemoved: () => {},
  })
}
