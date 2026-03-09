import { TOKEN_WATCH_INTERVAL_MS } from './constants'
import { loadConfig, getProjectList } from './config-manager'
import { logger } from './logger'
import type { ProjectRegistration } from './types'

export function startTokenWatcher(
  projects: ProjectRegistration[],
  onTokenUpdate: (projectCode: string, newToken: string) => void,
): { stop: () => void } {
  const currentTokens = new Map<string, string>()
  for (const p of projects) {
    currentTokens.set(p.projectCode, p.token)
  }

  const timer = setInterval(() => {
    try {
      const config = loadConfig()
      if (!config) return

      const configProjects = getProjectList(config)
      for (const cp of configProjects) {
        const currentToken = currentTokens.get(cp.projectCode)
        if (currentToken !== undefined && cp.token !== currentToken) {
          logger.debug(`Token changed for project ${cp.projectCode}`)
          currentTokens.set(cp.projectCode, cp.token)
          onTokenUpdate(cp.projectCode, cp.token)
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
