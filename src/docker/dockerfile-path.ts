import { join } from 'path'
import { existsSync } from 'fs'

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
