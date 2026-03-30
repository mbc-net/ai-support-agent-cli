import { join, dirname } from 'path'
import { existsSync } from 'fs'

import { getConfigDir } from '../config-manager'

/**
 * Get the path to the Dockerfile included in the npm package.
 * __dirname at runtime is dist/docker/, so we go up two levels to reach the package root.
 */
export function getDockerfilePath(): string {
  const packageRoot = getDockerContextDir()
  const dockerfilePath = join(packageRoot, 'docker', 'Dockerfile')
  if (!existsSync(dockerfilePath)) {
    throw new Error(`Dockerfile not found: ${dockerfilePath}`)
  }
  return dockerfilePath
}

/**
 * Get the Docker build context directory (package root).
 */
export function getDockerContextDir(): string {
  return join(__dirname, '..', '..')
}

/**
 * Get the path to the Dockerfile in the config directory.
 * (~/.ai-support-agent/Dockerfile)
 */
export function getConfigDockerfilePath(): string {
  return join(getConfigDir(), 'Dockerfile')
}

export interface DockerfileResolution {
  dockerfilePath: string
  contextDir: string
}

/**
 * Resolve which Dockerfile to use for the Docker build.
 * Priority: customPath > configDir/Dockerfile (if exists) > bundled default
 */
export function resolveDockerfile(customPath?: string): DockerfileResolution {
  if (customPath) {
    if (!existsSync(customPath)) {
      throw new Error(`Dockerfile not found: ${customPath}`)
    }
    return { dockerfilePath: customPath, contextDir: dirname(customPath) }
  }
  const configDockerfile = getConfigDockerfilePath()
  if (existsSync(configDockerfile)) {
    return { dockerfilePath: configDockerfile, contextDir: dirname(configDockerfile) }
  }
  return { dockerfilePath: getDockerfilePath(), contextDir: getDockerContextDir() }
}
