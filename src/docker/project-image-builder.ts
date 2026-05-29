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
import { buildDockerEnv } from './dockerfile-generator'
import { makeSessionId, getDockerPath } from './docker-utils'

/** Maximum total log size kept in memory per session (2 MB). Older content is discarded. */
const MAX_SESSION_LOG_BYTES = 2 * 1024 * 1024
// API の SubmitLogChunkDto.text @MaxLength に合わせた上限（100,000 バイト）
const MAX_LOG_CHUNK_BYTES = 100_000

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
  let seq = 0
  let fullLog = ''
  let logTruncated = false
  let buf = ''

  const flush = async (): Promise<void> => {
    if (!buf) return
    const text = buf
    buf = ''
    if (!logTruncated) {
      if (fullLog.length + text.length <= MAX_SESSION_LOG_BYTES) {
        fullLog += text
      } else {
        const remaining = MAX_SESSION_LOG_BYTES - fullLog.length
        fullLog += remaining > 0 ? text.slice(0, remaining) : ''
        logTruncated = true
        logger.warn('[docker] Build log exceeded 2 MB limit; remaining output will not be saved to S3')
      }
    }
    if (apiClient) {
      for (let offset = 0; offset < text.length; offset += MAX_LOG_CHUNK_BYTES) {
        const slice = text.slice(offset, offset + MAX_LOG_CHUNK_BYTES)
        await apiClient.submitLogChunk({ agentId: agentId ?? '', projectCode, logType: 'docker-build', sessionId, seq: ++seq, text: slice })
          .catch((e: unknown) => logger.warn(`[docker] Failed to send log chunk: ${e}`))
      }
    }
  }

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
      buf += text
      if (buf.length > 4096) {
        void flush()
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (err) => reject(err))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`docker build exited with code ${code}`))
    })
  }).catch((e: unknown) => { buildError = e instanceof Error ? e : new Error(String(e)) })

  await flush()

  if (apiClient && fullLog) {
    await apiClient.saveSessionLog({ agentId: agentId ?? '', projectCode, logType: 'docker-build', sessionId, content: fullLog })
      .catch((e: unknown) => logger.warn(`[docker] Failed to upload build log to S3: ${e}`))
  }

  if (buildError) throw buildError
  logger.success(`[docker] Project image built: ${imageTag}`)
}
