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
  onUpdateComplete?: () => void

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

    this.spawnChild(project.projectCode, startMessage)
  }

  private spawnChild(projectCode: string, startMessage: IpcStartMessage): void {
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
      restartCount: this.processes.get(projectCode)?.restartCount ?? 0,
      startMessage,
    }

    this.processes.set(projectCode, managed)

    child.on('message', (msg: unknown) => {
      if (!isChildToParentMessage(msg)) return
      this.handleChildMessage(msg)
    })

    child.on('exit', (code, signal) => {
      if (this.stopping) return
      logger.warn(
        `Child process for ${projectCode} exited (code=${code}, signal=${signal})`,
      )
      this.handleChildExit(projectCode)
    })

    child.send(startMessage)
    logger.info(`Forked child process for ${projectCode} (pid=${child.pid})`)
  }

  private resetRestartCount(projectCode: string): void {
    const managed = this.processes.get(projectCode)
    if (managed) managed.restartCount = 0
  }

  private handleChildMessage(msg: ChildToParentMessage): void {
    switch (msg.type) {
      case 'started':
        logger.info(`Project ${msg.projectCode} started in child process`)
        this.resetRestartCount(msg.projectCode)
        break
      case 'error':
        logger.error(`Project ${msg.projectCode} error: ${msg.message}`)
        break
      case 'stopped':
        logger.info(`Project ${msg.projectCode} stopped`)
        break
      case 'busy_response':
        for (const handler of this.busyResponseHandlers) {
          handler(msg)
        }
        break
      case 'update_complete':
        logger.info(`Project ${msg.projectCode} update complete, notifying runner`)
        this.onUpdateComplete?.()
        break
    }
  }

  private handleChildExit(projectCode: string): void {
    const managed = this.processes.get(projectCode)
    if (!managed) return

    if (managed.restartCount >= CHILD_PROCESS_MAX_RESTARTS) {
      logger.error(
        `Project ${projectCode} exceeded max restarts (${CHILD_PROCESS_MAX_RESTARTS}). Not restarting.`,
      )
      this.processes.delete(projectCode)
      return
    }

    managed.restartCount++
    logger.info(
      `Restarting ${projectCode} in ${CHILD_PROCESS_RESTART_DELAY_MS}ms (attempt ${managed.restartCount}/${CHILD_PROCESS_MAX_RESTARTS})`,
    )

    const timer = setTimeout(() => {
      this.restartTimers.delete(projectCode)
      if (this.stopping) return
      this.spawnChild(projectCode, managed.startMessage)
    }, CHILD_PROCESS_RESTART_DELAY_MS)
    this.restartTimers.set(projectCode, timer)
  }

  /**
   * 特定プロジェクトの子プロセスを graceful shutdown する
   */
  async stopProject(projectCode: string, timeoutMs: number = CHILD_PROCESS_STOP_TIMEOUT_MS): Promise<void> {
    // pending restart timer があればキャンセル
    const restartTimer = this.restartTimers.get(projectCode)
    if (restartTimer) {
      clearTimeout(restartTimer)
      this.restartTimers.delete(projectCode)
    }

    const managed = this.processes.get(projectCode)
    if (!managed) return

    if (managed.child.connected) {
      managed.child.send({ type: 'shutdown' })
      logger.debug(`Sent shutdown to ${projectCode}`)
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn(`Force killing ${projectCode} (timeout)`)
        managed.child.kill('SIGKILL')
        resolve()
      }, timeoutMs)

      managed.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })

    this.processes.delete(projectCode)
    logger.info(`Project ${projectCode} stopped and removed`)
  }

  hasProject(projectCode: string): boolean {
    return this.processes.has(projectCode)
  }

  sendTokenUpdate(projectCode: string, newToken: string): void {
    const managed = this.processes.get(projectCode)
    if (!managed) return

    if (managed.child.connected) {
      managed.child.send({ type: 'token_update', token: newToken })
      logger.debug(`Sent token update to ${projectCode}`)
    }

    // Update stored token so restarts use the new token
    managed.startMessage.project = { ...managed.startMessage.project, token: newToken }
    managed.project = { ...managed.project, token: newToken }
  }

  sendUpdateToAll(): void {
    for (const [projectCode, managed] of this.processes) {
      if (managed.child.connected) {
        managed.child.send({ type: 'update' })
        logger.debug(`Sent update to ${projectCode}`)
      }
    }
  }

  async stopAll(timeoutMs: number = CHILD_PROCESS_STOP_TIMEOUT_MS): Promise<void> {
    this.stopping = true

    for (const timer of this.restartTimers.values()) clearTimeout(timer)
    this.restartTimers.clear()

    const shutdownPromises: Promise<void>[] = []

    for (const [projectCode, managed] of this.processes) {
      if (managed.child.connected) {
        managed.child.send({ type: 'shutdown' })
        logger.debug(`Sent shutdown to ${projectCode}`)
      }

      shutdownPromises.push(
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            logger.warn(`Force killing ${projectCode} (timeout)`)
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
    const connectedProcesses = Array.from(this.processes.entries())
      .filter(([, m]) => m.child.connected)

    if (connectedProcesses.length === 0) return false

    return new Promise<boolean>((resolve) => {
      const pending = new Set(connectedProcesses.map(([code]) => code))
      let anyBusy = false

      const timer = setTimeout(() => {
        cleanup()
        // Timed-out children are treated as not busy (they may be dead/stuck)
        resolve(anyBusy)
      }, timeoutMs)

      const handler = (msg: IpcBusyResponseMessage): void => {
        if (msg.busy) anyBusy = true
        pending.delete(msg.projectCode)
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

      for (const [, managed] of connectedProcesses) {
        managed.child.send({ type: 'busy_query' })
      }
    })
  }

  getRunningCount(): number {
    return this.processes.size
  }
}
