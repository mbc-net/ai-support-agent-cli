/**
 * DockerSupervisor — manages one Docker container per project
 *
 * Spawned from runInDocker() when multiple projects are configured.
 */

import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getProjectImageTag } from './dockerfile-path'
import {
  CLI_FLAG_VERBOSE,
  CLI_FLAG_NO_AUTO_UPDATE,
  CLI_FLAG_NO_DOCKER,
  DOCKER_BUILD_ERROR_MAX_BYTES,
  DOCKER_LOG_FLUSH_INTERVAL_MS,
  DOCKER_MARKER_BUILT_HASH,
  DOCKER_MARKER_CUSTOMIZATION_HASH,
  DOCKER_MARKER_REBUILD_NEEDED,
  DOCKER_MARKER_REGISTERED_AGENT_ID,
  DOCKER_MAX_LOG_CHUNK_BYTES,
  DOCKER_MAX_SESSION_LOG_BYTES,
  DOCKER_RESTART_EXIT_CODE,
  DOCKER_UPDATE_EXIT_CODE,
} from '../constants'
import { t } from '../i18n'
import { logger, getProjectColor, makeLinePrefixer } from '../logger'
import { removePidFile } from '../pid-manager'
import { ApiClient } from '../api-client'
import type { ProjectRegistration } from '../types'
import { atomicWriteFile, getErrorMessage } from '../utils'
import type { DockerRunOptions } from './docker-runner'
import { IMAGE_NAME, buildContainerName, removeStaleContainer, makeSessionId, resolveImageTag, getDockerPath } from './docker-utils'
import { buildProjectVolumeMounts } from './volume-mount-builder'
import { buildDevMounts } from './docker-utils'
import { buildProjectImage } from './project-image-builder'
import { getProjectConfigHostDir } from '../utils/path-utils'
import { migrateProjectConfigDir } from './project-config'
import { installUpdateAndRestart } from './update-handler'

interface DockerContainerHandle {
  project: ProjectRegistration
  child: ChildProcess
  version: string
  closeHandled: boolean
  /** Resolves when the container process has exited and all log flushes have been initiated. */
  closedPromise: Promise<void>
  resolveClosed: () => void
  /** Path to the --cidfile written by docker run; used to read the container ID for docker stop. */
  cidFile: string
}

export class DockerSupervisor {
  private handles = new Map<string, DockerContainerHandle>()
  private updating = false
  private opts: DockerRunOptions
  private version: string
  private onAllStopped: (() => void) | undefined
  private readonly defaultAgentId: string | undefined
  /** Per-project agentId updated when the container registers with the API. */
  private projectAgentIds = new Map<string, string>()
  private sigintHandler: (() => void) | undefined
  private sigtermHandler: (() => void) | undefined

  constructor(version: string, opts: DockerRunOptions) {
    this.version = version
    this.opts = opts
    this.defaultAgentId = opts.agentId
  }

  private projectKey(project: ProjectRegistration): string {
    return `${project.tenantCode}/${project.projectCode}`
  }

  private getProjectAgentId(project: ProjectRegistration): string | undefined {
    return this.projectAgentIds.get(this.projectKey(project)) ?? this.defaultAgentId
  }

  private setProjectAgentId(project: ProjectRegistration, agentId: string): void {
    this.projectAgentIds.set(this.projectKey(project), agentId)
  }

  /**
   * Read the `registered-agent-id` marker file (written by the container
   * after it registers with the server) and apply it to in-memory state if
   * it differs from what we already have.
   *
   * Single source of truth for the "read marker → compare → update" idiom
   * that used to be duplicated three times in this class — before a rebuild,
   * before spawning, and inside the runtime `fs.watch` callback — each with
   * its own copy of the readFileSync/trim/compare logic and its own risk of
   * drifting from the other two.
   *
   * Reads directly in a try/catch rather than gating on `fs.existsSync`
   * first: the watch-callback call site can race a rename event against the
   * container still writing the file, so a plain existsSync-then-read would
   * reintroduce that TOCTOU gap the original watch-callback's try/catch was
   * written to avoid. The other two previous call sites only guarded with
   * `existsSync` (a read failure after that check would have propagated
   * uncaught); swallowing ENOENT/any read failure here is a deliberate
   * unification onto the safer of the two prior behaviors, not a no-op
   * refactor of already-identical code.
   *
   * Returns the previous/new id pair when the marker caused an update, or
   * `null` when the marker is absent, unreadable, empty, or unchanged
   * (nothing to log).
   */
  private applyRegisteredAgentId(
    project: ProjectRegistration,
    registeredAgentIdPath: string,
  ): { previousId: string | undefined; newId: string } | null {
    let registeredId: string
    try {
      registeredId = fs.readFileSync(registeredAgentIdPath, 'utf-8').trim()
    } catch {
      return null
    }
    const previousId = this.getProjectAgentId(project)
    if (!registeredId || registeredId === previousId) return null
    this.setProjectAgentId(project, registeredId)
    return { previousId, newId: registeredId }
  }

  private createProjectApiClient(project: ProjectRegistration): ApiClient {
    return new ApiClient(project.apiUrl, project.token)
  }

  start(projects: ProjectRegistration[], onStop?: () => void): void {
    this.onAllStopped = onStop

    for (const project of projects) {
      // Per-project SYNCHRONOUS failures must not abort the start loop —
      // log and continue so the remaining valid projects still come up.
      // Failure surfaces covered:
      //   - `assertProjectCodeIsSafe` in `buildProjectVolumeMounts` (sync throw)
      //   - mkdir / chmod errors building the per-project mount
      // NOT covered (these are async, surface via child process events):
      //   - container start failures after `spawn()` returns
      //   - container exit non-zero
      // `migrateProjectConfigDir` swallows mkdir/rename errors via its own
      // try/catch, but the `fs.existsSync` checks BEFORE that try/catch can
      // still throw on a permission-denied or I/O error. Wrapping migrate
      // in this outer try is therefore not purely defensive — it also
      // covers that surface; future readers should not remove the outer
      // try assuming migrate is fully internally-fault-tolerant.
      // Use the docker-specific i18n key so operators aren't misled into
      // looking at the systemd/launchd install subsystem.
      try {
        migrateProjectConfigDir(project)
        this.spawnProject(project)
      } catch (error) {
        const message = getErrorMessage(error)
        logger.error(t('docker.projectSpawnFailed', { projectCode: project.projectCode, message }))
      }
    }

    // Setup shutdown handlers
    let shuttingDown = false
    const shutdown = (): void => {
      if (shuttingDown) return
      shuttingDown = true
      // Set updating flag so the close handler does not call process.exit again
      this.updating = true
      if (this.sigintHandler) process.removeListener('SIGINT', this.sigintHandler)
      if (this.sigtermHandler) process.removeListener('SIGTERM', this.sigtermHandler)
      removePidFile()
      logger.info(t('runner.shuttingDown'))
      const closedPromises = [...this.handles.values()].map((h) => h.closedPromise)
      this.stopAll()
      onStop?.()
      const shutdownTimer = setTimeout(() => {
        logger.warn('[docker] Shutdown timed out waiting for log flush; forcing exit')
        process.exit(0)
      }, this.opts.shutdownTimeoutMs ?? 10_000)
      void Promise.all(closedPromises).then(() => {
        clearTimeout(shutdownTimer)
        process.exit(0)
      })
    }
    this.sigintHandler = (): void => { logger.info('[docker] SIGINT received, shutting down...'); shutdown() }
    this.sigtermHandler = (): void => { logger.info('[docker] SIGTERM received, shutting down...'); shutdown() }
    process.on('SIGINT', this.sigintHandler)
    process.on('SIGTERM', this.sigtermHandler)

    // On macOS/Linux, Ctrl+C may not deliver SIGINT to Node.js when the terminal
    // is in cooked mode and child processes share the process group. As a fallback,
    // read \x03 (ETX) directly from stdin when it is a TTY in raw mode.
    /* istanbul ignore next -- TTY-only path, not testable in CI */
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.on('data', (chunk: Buffer) => {
        if (chunk[0] === 0x03) { // Ctrl+C
          shutdown()
        }
      })
    }
  }

  private getImageTag(project: ProjectRegistration): string {
    const projectTag = getProjectImageTag(project.tenantCode, project.projectCode, this.version)
    return resolveImageTag(projectTag, `${IMAGE_NAME}:${this.version}`)
  }

  private async rebuildAndRestart(project: ProjectRegistration, projectConfigHostDir: string, forceIfDockerfileExists = false): Promise<void> {
    const rebuildMarker = path.join(projectConfigHostDir, DOCKER_MARKER_REBUILD_NEEDED)
    const projectDockerfile = path.join(projectConfigHostDir, 'Dockerfile')
    const hasMarker = fs.existsSync(rebuildMarker)
    const shouldBuild = hasMarker || (forceIfDockerfileExists && fs.existsSync(projectDockerfile))
    if (shouldBuild) {
      if (hasMarker) fs.unlinkSync(rebuildMarker)

      // Load the registered agentId before building so build logs are stored under
      // the correct agentId (the one shown in the Web UI), not the host agentId.
      const registeredAgentIdPath = path.join(projectConfigHostDir, DOCKER_MARKER_REGISTERED_AGENT_ID)
      this.applyRegisteredAgentId(project, registeredAgentIdPath)

      if (fs.existsSync(projectDockerfile)) {
        try {
          await buildProjectImage(project.tenantCode, project.projectCode, this.version, projectDockerfile, this.createProjectApiClient(project), this.getProjectAgentId(project))
          const srcHash = path.join(projectConfigHostDir, DOCKER_MARKER_CUSTOMIZATION_HASH)
          const dstHash = path.join(projectConfigHostDir, DOCKER_MARKER_BUILT_HASH)
          if (fs.existsSync(srcHash)) {
            fs.copyFileSync(srcHash, dstHash)
          }
          const buildErrorPath = path.join(projectConfigHostDir, 'docker-build-error')
          /* istanbul ignore next */
          if (fs.existsSync(buildErrorPath)) {
            fs.unlinkSync(buildErrorPath)
          }
        } catch (err: unknown) {
          const errorMsg = getErrorMessage(err)
          logger.error(`[docker] Image build failed: ${errorMsg}`)
          logger.warn(`[docker] Container ${this.projectKey(project)} will start with previous image due to build failure.`)
          const buildErrorPath = path.join(projectConfigHostDir, 'docker-build-error')
          const truncatedError = errorMsg.length > DOCKER_BUILD_ERROR_MAX_BYTES ? errorMsg.substring(0, DOCKER_BUILD_ERROR_MAX_BYTES) + '...(truncated)' : errorMsg
          /* istanbul ignore next */
          try {
            atomicWriteFile(buildErrorPath, truncatedError)
          } catch (writeErr) {
            logger.warn(`[docker] Failed to write build error file: ${getErrorMessage(writeErr)}`)
          }
          const srcHash = path.join(projectConfigHostDir, DOCKER_MARKER_CUSTOMIZATION_HASH)
          const dstHash = path.join(projectConfigHostDir, DOCKER_MARKER_BUILT_HASH)
          if (fs.existsSync(srcHash)) {
            fs.copyFileSync(srcHash, dstHash)
          }
        }
      }
    }
    this.spawnProject(project)
  }

  private spawnProject(project: ProjectRegistration): void {
    const key = this.projectKey(project)
    const projectConfigHostDir = getProjectConfigHostDir(project.tenantCode, project.projectCode)

    // Pre-startup hash check: if docker-customization-hash !== docker-built-hash,
    // rebuild before starting the container
    const customizationHashPath = path.join(projectConfigHostDir, DOCKER_MARKER_CUSTOMIZATION_HASH)
    const builtHashPath = path.join(projectConfigHostDir, DOCKER_MARKER_BUILT_HASH)
    if (fs.existsSync(customizationHashPath) && fs.existsSync(builtHashPath)) {
      const customizationHash = fs.readFileSync(customizationHashPath, 'utf-8').trim()
      const builtHash = fs.readFileSync(builtHashPath, 'utf-8').trim()
      if (customizationHash !== builtHash) {
        logger.info(`[docker] Pre-startup hash mismatch for ${key}, rebuilding before start...`)
        void this.rebuildAndRestart(project, projectConfigHostDir, true)
        return
      }
    }

    // Load the server-assigned agentId written by the container after registration.
    const registeredAgentIdPath = path.join(projectConfigHostDir, DOCKER_MARKER_REGISTERED_AGENT_ID)
    const appliedAtStartup = this.applyRegisteredAgentId(project, registeredAgentIdPath)
    if (appliedAtStartup) {
      logger.info(`[docker] Using registered agentId for ${key}: ${appliedAtStartup.newId}`)
    }

    const { mounts, envArgs } = buildProjectVolumeMounts(project, projectConfigHostDir)

    const containerArgs = [
      'ai-support-agent', 'start', CLI_FLAG_NO_DOCKER,
      '--project', key,
    ]
    if (this.opts.pollInterval !== undefined) {
      containerArgs.push('--poll-interval', String(this.opts.pollInterval))
    }
    if (this.opts.heartbeatInterval !== undefined) {
      containerArgs.push('--heartbeat-interval', String(this.opts.heartbeatInterval))
    }
    if (this.opts.verbose) {
      containerArgs.push(CLI_FLAG_VERBOSE)
    }
    if (this.opts.autoUpdate === false) {
      containerArgs.push(CLI_FLAG_NO_AUTO_UPDATE)
    }
    if (this.opts.updateChannel) {
      containerArgs.push('--update-channel', this.opts.updateChannel)
    }

    const imageTag = this.getImageTag(project)
    const containerName = buildContainerName(project.tenantCode, project.projectCode, this.opts.agentId)
    removeStaleContainer(containerName)
    const cidFile = path.join(os.tmpdir(), `ai-support-agent-${project.tenantCode}-${project.projectCode}-${Date.now()}.cid`)
    const dockerArgs = [
      'run', '--rm', '--name', containerName, '--cidfile', cidFile,
      ...(process.getuid ? ['--user', `${process.getuid()}:${process.getgid!()}`] : []),
      ...mounts,
      ...buildDevMounts(),
      ...envArgs,
      imageTag,
      ...containerArgs,
    ]

    const projectColor = getProjectColor(key)
    const colorReset = '\x1b[0m'
    const logPrefix = `${projectColor}[${key}]${colorReset} `
    logger.info(`[docker] Starting container for project: ${key}`)
    const child = spawn(getDockerPath(), dockerArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

    let resolveClosed!: () => void
    const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve })
    const handle: DockerContainerHandle = {
      project,
      child,
      version: this.version,
      closeHandled: false,
      closedPromise,
      resolveClosed,
      cidFile,
    }
    this.handles.set(key, handle)

    // Stream container stdout/stderr to host terminal and API for real-time log viewing
    const projectApiClient = this.createProjectApiClient(project)
    if (projectApiClient) {
      const sessionId = makeSessionId()
      let seq = 0
      let fullLog = ''
      let logTruncated = false
      let buf = ''
      const apiClient = projectApiClient
      const supervisor = this
      const getAgentId = (): string => supervisor.getProjectAgentId(project) ?? ''

      // Watch for the registered agentId file written by the container after registration
      const noopWatcher: Pick<fs.FSWatcher, 'close'> = { close: () => undefined }
      let registeredIdWatcher: Pick<fs.FSWatcher, 'close'> = noopWatcher
      try {
        registeredIdWatcher = fs.watch(projectConfigHostDir, (eventType, filename) => {
          if (filename === DOCKER_MARKER_REGISTERED_AGENT_ID && (eventType === 'rename' || eventType === 'change')) {
            try {
              const applied = supervisor.applyRegisteredAgentId(project, registeredAgentIdPath)
              if (applied) {
                logger.info(`[docker] Container registered with agentId: ${applied.newId} (was: ${applied.previousId})`)
              }
            } catch {
              // File may not exist yet if rename event fires before write completes
            }
          }
        })
      } catch {
        // Directory watch may fail if projectConfigHostDir doesn't exist yet — ignore
      }

      const flush = async (): Promise<void> => {
        if (!buf) return
        const text = buf
        buf = ''
        if (!logTruncated) {
          if (fullLog.length + text.length <= DOCKER_MAX_SESSION_LOG_BYTES) {
            fullLog += text
          } else {
            const remaining = DOCKER_MAX_SESSION_LOG_BYTES - fullLog.length
            fullLog += remaining > 0 ? text.slice(0, remaining) : ''
            logTruncated = true
            logger.warn(`[docker] Container log for ${key} exceeded 2 MB limit; remaining output will not be saved to S3`)
          }
        }
        // 1 フラッシュのテキストが API 上限を超える場合は分割して送信
        for (let offset = 0; offset < text.length; offset += DOCKER_MAX_LOG_CHUNK_BYTES) {
          const slice = text.slice(offset, offset + DOCKER_MAX_LOG_CHUNK_BYTES)
          await apiClient.submitLogChunk({ agentId: getAgentId(), projectCode: project.projectCode, logType: 'container', sessionId, seq: ++seq, text: slice })
            .catch((e: unknown) => logger.warn(`[docker] log chunk failed: ${e}`))
        }
      }

      const flushTimer = setInterval(() => { void flush() }, DOCKER_LOG_FLUSH_INTERVAL_MS).unref()

      const writeStdout = makeLinePrefixer(logPrefix, (s) => process.stdout.write(s))
      const writeStderr = makeLinePrefixer(logPrefix, (s) => process.stderr.write(s))
      child.stdout?.on('data', (d: Buffer) => { const t = d.toString(); writeStdout(t); buf += t })
      child.stderr?.on('data', (d: Buffer) => { const t = d.toString(); writeStderr(t); buf += t })

      child.on('close', () => {
        registeredIdWatcher.close()
        clearInterval(flushTimer)
        void (async () => {
          try {
            await flush()
            if (fullLog) {
              await apiClient.saveSessionLog({ agentId: getAgentId(), projectCode: project.projectCode, logType: 'container', sessionId, content: fullLog })
                .catch((e: unknown) => logger.warn(`[docker] S3 upload failed: ${e}`))
            }
          } catch /* istanbul ignore next */ {
            // ignore flush / saveSessionLog errors — always resolve so shutdown can proceed
          } finally {
            handle.resolveClosed()
          }
        })()
      })
    }

    child.on('error', (err) => {
      logger.error(`[docker] Container error for ${key}: ${getErrorMessage(err)}`)
    })

    child.on('close', (code) => {
      if (handle.closeHandled) return
      handle.closeHandled = true
      this.handles.delete(key)
      // Clean up cidfile
      try { fs.unlinkSync(handle.cidFile) } catch { /* ignore */ }

      if (code === DOCKER_UPDATE_EXIT_CODE && !this.updating) {
        this.updating = true
        logger.info(`[docker] Container ${key} exited for update. Stopping all containers and rebuilding...`)
        this.stopAll()
        void installUpdateAndRestart(projectConfigHostDir).catch((err) => {
          logger.error(`[docker] Update failed: ${getErrorMessage(err)}`)
          process.exit(1)
        })
        return
      }

      if (code === DOCKER_RESTART_EXIT_CODE && !this.updating) {
        logger.info(`[docker] Container ${key} requested restart. Rebuilding image if needed...`)
        void this.rebuildAndRestart(project, projectConfigHostDir, true).catch((err) => {
          logger.error(`[docker] Restart failed: ${getErrorMessage(err)}`)
        })
        return
      }

      if (this.handles.size === 0 && !this.updating) {
        // All containers have exited cleanly
        this.onAllStopped?.()
        process.exit(code ?? 0)
      }
    })
  }

  stopAll(): void {
    for (const [key, handle] of this.handles) {
      if (!handle.closeHandled) {
        logger.info(`[docker] Stopping container for project: ${key}`)
        let stopped = false
        try {
          /* istanbul ignore next */
          if (fs.existsSync(handle.cidFile)) {
            const containerId = fs.readFileSync(handle.cidFile, 'utf-8').trim()
            /* istanbul ignore next */
            if (containerId) {
              spawn(getDockerPath(), ['stop', '--time', '5', containerId], { stdio: 'ignore' })
              stopped = true
            }
          }
        } catch /* istanbul ignore next */ {
          // Ignore errors — fall through to child.kill
        }
        if (!stopped) {
          handle.child.kill('SIGTERM')
        }
      }
    }
  }
}
