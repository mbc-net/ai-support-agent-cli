/**
 * Per-project Docker image builder
 *
 * Builds a project-specific Docker image and streams build logs to the API.
 */

import { spawn } from 'child_process'

import { getDockerContextDir } from './dockerfile-path'
import { getProjectImageTag } from './dockerfile-path'
import { logger, getProjectColor, makeLinePrefixer } from '../logger'
import { ApiClient } from '../api-client'
import { DockerLogBuffer } from './docker-log-buffer'
import { buildDockerEnv } from './dockerfile-generator'
import { makeSessionId, getDockerPath } from './docker-utils'
import { toError } from '../utils'

/**
 * Build a per-project Docker image using the given Dockerfile.
 * Streams stdout/stderr to both the host terminal and the API (for real-time log viewing).
 */
export async function buildProjectImage(
  tenantCode: string,
  projectCode: string,
  baseVersion: string,
  dockerfilePath: string,
  apiClient?: ApiClient,
  agentId?: string,
): Promise<void> {
  const imageTag = getProjectImageTag(tenantCode, projectCode, baseVersion)
  const contextDir = getDockerContextDir()
  const projectKey = `${tenantCode}#${projectCode}`
  const color = getProjectColor(projectKey)
  const reset = '\x1b[0m'
  const prefix = `${color}[${projectKey}]${reset} `
  logger.info(`[docker] Building project image: ${imageTag}`)

  const sessionId = makeSessionId()
  const logBuffer = new DockerLogBuffer(
    () => logger.warn('[docker] Build log exceeded 2 MB limit; remaining output will not be saved to S3'),
    apiClient ? (seq, text) => apiClient.submitLogChunk({ agentId: agentId ?? '', projectCode, logType: 'docker-build', sessionId, seq, text })
      .catch((e: unknown) => logger.warn(`[docker] Failed to send log chunk: ${e}`)) : undefined,
  )

  let buildError: Error | undefined
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(getDockerPath(), [
      'build', '-t', imageTag, '--pull=false', '--progress=plain',
      '--build-arg', `AGENT_VERSION=${baseVersion}`,
      '-f', dockerfilePath, contextDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: buildDockerEnv() })

    const writePrefixed = makeLinePrefixer(prefix, (s) => process.stdout.write(s))
    const onData = (d: Buffer): void => {
      const text = d.toString()
      writePrefixed(text)
      logBuffer.append(text)
      if (logBuffer.bufferedLength > 4096) {
        void logBuffer.flush()
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (err) => reject(err))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`docker build exited with code ${code}`))
    })
  }).catch((e: unknown) => { buildError = toError(e) })

  await logBuffer.flush()

  if (apiClient && logBuffer.content) {
    await apiClient.saveSessionLog({ agentId: agentId ?? '', projectCode, logType: 'docker-build', sessionId, content: logBuffer.content })
      .catch((e: unknown) => logger.warn(`[docker] Failed to upload build log to S3: ${e}`))
  }

  if (buildError) throw buildError
  logger.success(`[docker] Project image built: ${imageTag}`)
}
