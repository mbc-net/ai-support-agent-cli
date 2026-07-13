import { fork, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

import {
  CHILD_PROCESS_MAX_RESTARTS,
  CHILD_PROCESS_RESTART_DELAY_MS,
  CHILD_PROCESS_STOP_TIMEOUT_MS,
  BUSY_QUERY_TIMEOUT_MS,
} from './constants'
import type { ChildToParentMessage, IpcStartMessage, IpcBusyResponseMessage } from './ipc-types'
import { isChildToParentMessage } from './ipc-types'
import { logger } from './logger'
import { projectKey } from './project-key'
import type { AgentChatMode, ProjectRegistration } from './types'

interface ManagedProcess {
  child: ChildProcess
  project: ProjectRegistration
  restartCount: number
  startMessage: IpcStartMessage
}

export class ChildProcessManager {
  private readonly processes = new Map<string, ManagedProcess>()
  private readonly restartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly busyResponseHandlers: Array<(msg: IpcBusyResponseMessage) => void> = []
  private stopping = false
  onUpdateComplete?: (project: ProjectRegistration) => void

  forkProject(
    project: ProjectRegistration,
    agentId: string,
    options: {
      pollInterval: number
      heartbeatInterval: number
      agentChatMode?: AgentChatMode
      defaultProjectDir?: string
    },
  ): void {
    const startMessage: IpcStartMessage = {
      type: 'start',
      project,
      agentId,
      options,
    }

    this.spawnChild(projectKey(project), startMessage)
  }

  private spawnChild(key: string, startMessage: IpcStartMessage): void {
    // ts-node 環境では .ts ファイルを使用、ビルド後は .js ファイルを使用
    const jsPath = join(__dirname, 'project-worker.js')
    const tsPath = join(__dirname, 'project-worker.ts')
    const workerPath = existsSync(jsPath) ? jsPath : tsPath
    const execArgv = workerPath.endsWith('.ts') ? ['--require', 'ts-node/register'] : []
    const child = fork(workerPath, [], {
      stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
      execArgv,
    })

    const managed: ManagedProcess = {
      child,
      project: startMessage.project,
      restartCount: this.processes.get(key)?.restartCount ?? 0,
      startMessage,
    }

    this.processes.set(key, managed)

    child.on('message', (msg: unknown) => {
      if (!isChildToParentMessage(msg)) return
      this.handleChildMessage(key, msg)
    })

    child.on('exit', (code, signal) => {
      if (this.stopping) return
      logger.warn(
        `Child process for ${key} exited (code=${code}, signal=${signal})`,
      )
      this.handleChildExit(key)
    })

    child.send(startMessage)
    logger.info(`Forked child process for ${key} (pid=${child.pid})`)
  }

  private handleChildMessage(key: string, msg: ChildToParentMessage): void {
    const managed = this.processes.get(key)
    switch (msg.type) {
      case 'started':
        logger.info(`Project ${key} started in child process`)
        if (managed) managed.restartCount = 0
        break
      case 'error':
        logger.error(`Project ${key} error: ${msg.message}`)
        break
      case 'stopped':
        logger.info(`Project ${key} stopped`)
        break
      case 'busy_response':
        for (const handler of this.busyResponseHandlers) {
          handler(msg)
        }
        break
      case 'update_complete':
        logger.info(`Project ${key} update complete, notifying runner`)
        if (managed) this.onUpdateComplete?.(managed.project)
        break
      case 'auth_rejected':
        logger.error(
          `Project ${key} ${msg.transport} connection permanently rejected by the server (authentication). ` +
            `That feature is now offline for this project — check its token and Agent ID configuration.`,
        )
        break
    }
  }

  private handleChildExit(key: string): void {
    const managed = this.processes.get(key)
    if (!managed) return

    if (managed.restartCount >= CHILD_PROCESS_MAX_RESTARTS) {
      logger.error(
        `Project ${key} exceeded max restarts (${CHILD_PROCESS_MAX_RESTARTS}). Not restarting.`,
      )
      this.processes.delete(key)
      return
    }

    managed.restartCount++
    logger.info(
      `Restarting ${key} in ${CHILD_PROCESS_RESTART_DELAY_MS}ms (attempt ${managed.restartCount}/${CHILD_PROCESS_MAX_RESTARTS})`,
    )

    const timer = setTimeout(() => {
      this.restartTimers.delete(key)
      if (this.stopping) return
      this.spawnChild(key, managed.startMessage)
    }, CHILD_PROCESS_RESTART_DELAY_MS).unref()
    this.restartTimers.set(key, timer)
  }

  /**
   * 特定プロジェクトの子プロセスを graceful shutdown する
   */
  async stopProject(project: ProjectRegistration, timeoutMs: number = CHILD_PROCESS_STOP_TIMEOUT_MS): Promise<void> {
    const key = projectKey(project)

    const restartTimer = this.restartTimers.get(key)
    if (restartTimer) {
      clearTimeout(restartTimer)
      this.restartTimers.delete(key)
    }

    const managed = this.processes.get(key)
    if (!managed) return

    if (managed.child.connected) {
      managed.child.send({ type: 'shutdown' })
      logger.debug(`Sent shutdown to ${key}`)
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn(`Force killing ${key} (timeout)`)
        managed.child.kill('SIGKILL')
        resolve()
      }, timeoutMs)

      managed.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    this.processes.delete(key)
    logger.info(`Project ${key} stopped and removed`)
  }

  hasProject(project: ProjectRegistration): boolean {
    return this.processes.has(projectKey(project))
  }

  sendTokenUpdate(project: ProjectRegistration, newToken: string): void {
    const key = projectKey(project)
    const managed = this.processes.get(key)
    if (!managed) return

    if (managed.child.connected) {
      managed.child.send({ type: 'token_update', token: newToken })
      logger.debug(`Sent token update to ${key}`)
    }

    // Update stored token so restarts use the new token
    managed.startMessage.project = { ...managed.startMessage.project, token: newToken }
    managed.project = { ...managed.project, token: newToken }
  }

  sendUpdateToAll(): void {
    for (const [key, managed] of this.processes) {
      if (managed.child.connected) {
        managed.child.send({ type: 'update' })
        logger.debug(`Sent update to ${key}`)
      }
    }
  }

  async stopAll(timeoutMs: number = CHILD_PROCESS_STOP_TIMEOUT_MS): Promise<void> {
    this.stopping = true

    for (const timer of this.restartTimers.values()) clearTimeout(timer)
    this.restartTimers.clear()

    const shutdownPromises: Promise<void>[] = []

    for (const [key, managed] of this.processes) {
      if (managed.child.connected) {
        managed.child.send({ type: 'shutdown' })
        logger.debug(`Sent shutdown to ${key}`)
      }

      shutdownPromises.push(
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            logger.warn(`Force killing ${key} (timeout)`)
            managed.child.kill('SIGKILL')
            resolve()
          }, timeoutMs)

          managed.child.once('exit', () => {
            clearTimeout(timer)
            resolve()
          })
        }),
      )
    }

    await Promise.all(shutdownPromises)
    this.processes.clear()
  }

  async isAnyBusy(timeoutMs: number = BUSY_QUERY_TIMEOUT_MS): Promise<boolean> {
    const connected: ManagedProcess[] = []
    const pending = new Set<string>()
    for (const [key, m] of this.processes) {
      if (m.child.connected) {
        connected.push(m)
        pending.add(key)
      }
    }

    if (connected.length === 0) return false

    return new Promise<boolean>((resolve) => {
      let anyBusy = false

      const timer = setTimeout(() => {
        cleanup()
        // Timed-out children are treated as not busy (they may be dead/stuck)
        resolve(anyBusy)
      }, timeoutMs)

      const handler = (msg: IpcBusyResponseMessage): void => {
        if (msg.busy) anyBusy = true
        pending.delete(projectKey(msg))
        if (pending.size === 0) {
          cleanup()
          resolve(anyBusy)
        }
      }

      const cleanup = (): void => {
        clearTimeout(timer)
        const idx = this.busyResponseHandlers.indexOf(handler)
        if (idx !== -1) this.busyResponseHandlers.splice(idx, 1)
      }

      this.busyResponseHandlers.push(handler)

      for (const managed of connected) {
        managed.child.send({ type: 'busy_query' })
      }
    })
  }

  getRunningCount(): number {
    return this.processes.size
  }
}
