import { ChildProcess, spawn } from 'child_process'
import * as http from 'http'

import { logger } from '../logger'
import { getErrorMessage } from '../utils'

import {
  VSCODE_DEFAULT_PORT,
  VSCODE_BIND_HOST,
  VSCODE_IDLE_TIMEOUT_MS,
  HEALTH_CHECK_INTERVAL_MS,
  STARTUP_TIMEOUT_MS,
} from './constants'

export interface VsCodeServerOptions {
  projectDir: string
  port?: number
}

/**
 * code-server プロセスのライフサイクル管理
 *
 * - 起動 / 停止 / ヘルスチェック
 * - アイドルタイムアウトによる自動停止
 * - 127.0.0.1 バインド（外部アクセス不可、トンネル経由のみ）
 */
export class VsCodeServer {
  private process: ChildProcess | null = null
  private readonly port: number
  private readonly projectDir: string
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(options: VsCodeServerOptions) {
    this.port = options.port ?? VSCODE_DEFAULT_PORT
    this.projectDir = options.projectDir
  }

  get isRunning(): boolean {
    return this.running
  }

  getPort(): number {
    return this.port
  }

  /**
   * code-server を起動する
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.debug('[vscode-server] Already running')
      return
    }

    logger.info(`[vscode-server] Starting code-server on ${VSCODE_BIND_HOST}:${this.port}`)

    this.process = spawn('code-server', [
      '--bind-addr', `${VSCODE_BIND_HOST}:${this.port}`,
      '--auth', 'none',
      '--disable-telemetry',
      '--disable-update-check',
      '--disable-getting-started-override',
      this.projectDir,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // code-server が XDG ディレクトリを使うよう設定
        XDG_DATA_HOME: `${this.projectDir}/.vscode-server/data`,
        XDG_CONFIG_HOME: `${this.projectDir}/.vscode-server/config`,
      },
    })

    // spawn の error イベント（コマンド未発見等）を検知するための Promise
    const proc = this.process
    const spawnError = new Promise<never>((_, reject) => {
      proc.on('error', (err) => {
        logger.error(`[vscode-server] Failed to spawn: ${err.message}`)
        reject(new Error(
          `code-server is not installed or not in PATH. Install it with: npm install -g code-server`,
        ))
      })
    })

    proc.stdout?.on('data', (data: Buffer) => {
      logger.debug(`[vscode-server] stdout: ${data.toString().trim()}`)
    })

    proc.stderr?.on('data', (data: Buffer) => {
      logger.debug(`[vscode-server] stderr: ${data.toString().trim()}`)
    })

    proc.on('exit', (code, signal) => {
      logger.info(`[vscode-server] Process exited (code=${code}, signal=${signal})`)
      this.running = false
      this.stopTimers()
    })

    // code-server の起動完了をヘルスチェックで待つ（spawn エラーがあれば即座に失敗）
    await Promise.race([this.waitForReady(), spawnError])
    this.running = true
    this.resetIdleTimer()
    this.startHealthCheck()

    logger.info(`[vscode-server] Started successfully on port ${this.port}`)
  }

  /**
   * code-server を停止する
   */
  stop(): void {
    if (!this.process) return

    logger.info('[vscode-server] Stopping code-server')
    this.running = false
    this.stopTimers()

    try {
      this.process.kill('SIGTERM')
      // 5秒後に強制終了
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL')
        }
      }, 5000)
    } catch (error) {
      logger.debug(`[vscode-server] Stop error: ${getErrorMessage(error)}`)
    }

    this.process = null
  }

  /**
   * アクティビティを記録してアイドルタイマーをリセットする
   */
  touch(): void {
    this.resetIdleTimer()
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      logger.info('[vscode-server] Idle timeout reached, stopping')
      this.stop()
    }, VSCODE_IDLE_TIMEOUT_MS)
  }

  private startHealthCheck(): void {
    this.healthTimer = setInterval(() => {
      this.checkHealth().catch((error) => {
        logger.warn(`[vscode-server] Health check failed: ${getErrorMessage(error)}`)
      })
    }, HEALTH_CHECK_INTERVAL_MS)
  }

  private stopTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
  }

  private async checkHealth(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const req = http.get(`http://${VSCODE_BIND_HOST}:${this.port}/healthz`, (res) => {
        if (res.statusCode === 200) {
          resolve()
        } else {
          reject(new Error(`Health check returned status ${res.statusCode}`))
        }
        res.resume()
      })
      req.on('error', reject)
      req.setTimeout(5000, () => {
        req.destroy()
        reject(new Error('Health check timeout'))
      })
    })
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < STARTUP_TIMEOUT_MS) {
      try {
        await this.checkHealth()
        return
      } catch {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    throw new Error(`code-server failed to start within ${STARTUP_TIMEOUT_MS}ms`)
  }
}
