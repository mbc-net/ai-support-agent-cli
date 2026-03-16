import { ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

import { logger } from '../logger'
import { buildSandboxInitScript } from '../terminal/sandbox-init-script'
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

    try {
      this.setupTerminalSandbox()
    } catch (error) {
      logger.warn(`[vscode-server] Failed to setup terminal sandbox: ${getErrorMessage(error)}`)
    }

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

  /**
   * code-server のターミナルにサンドボックスを適用する。
   * - bash/zsh 用の rc ファイルを生成し、サンドボックススクリプトを注入
   * - settings.json でサンドボックス付きターミナルプロファイルをデフォルトに設定
   * - Workspace Trust を有効化して別フォルダを開いた場合に restricted mode にする
   */
  private setupTerminalSandbox(): void {
    const resolvedDir = path.resolve(this.projectDir)
    const sandboxDir = path.join(resolvedDir, '.vscode-server', 'terminal-sandbox')
    fs.mkdirSync(sandboxDir, { recursive: true })

    const sandboxScript = buildSandboxInitScript(resolvedDir)

    // bash: --rcfile で注入
    const bashrc = `[ -f ~/.bashrc ] && source ~/.bashrc\n${sandboxScript}`
    fs.writeFileSync(path.join(sandboxDir, '.bashrc'), bashrc)

    // zsh: ZDOTDIR で注入
    const origZdotdir = (process.env.ZDOTDIR ?? process.env.HOME ?? '').replace(/'/g, "'\\''")
    const zshrc = `[ -f '${origZdotdir}/.zshrc' ] && source '${origZdotdir}/.zshrc'\n${sandboxScript}`
    fs.writeFileSync(path.join(sandboxDir, '.zshrc'), zshrc)

    // settings.json を生成
    const shell = process.env.SHELL ?? '/bin/bash'
    const isZsh = shell.endsWith('/zsh') || shell.endsWith('/zsh5')
    const defaultProfile = isZsh ? 'sandbox-zsh' : 'sandbox-bash'

    const sandboxBashProfile = {
      path: '/bin/bash',
      args: ['--rcfile', path.join(sandboxDir, '.bashrc')],
    }
    const sandboxZshProfile = {
      path: '/bin/zsh',
      args: ['--login'],
      env: { ZDOTDIR: sandboxDir },
    }

    const settings: Record<string, unknown> = {
      'terminal.integrated.profiles.osx': {
        'sandbox-bash': sandboxBashProfile,
        'sandbox-zsh': sandboxZshProfile,
      },
      'terminal.integrated.profiles.linux': {
        'sandbox-bash': sandboxBashProfile,
        'sandbox-zsh': sandboxZshProfile,
      },
      'terminal.integrated.defaultProfile.osx': defaultProfile,
      'terminal.integrated.defaultProfile.linux': defaultProfile,
      'terminal.integrated.cwd': resolvedDir,
      'security.workspace.trust.enabled': true,
      'security.workspace.trust.startupPrompt': 'never',
    }

    const settingsDir = path.join(resolvedDir, '.vscode-server', 'config', 'Code', 'User')
    fs.mkdirSync(settingsDir, { recursive: true })
    const settingsPath = path.join(settingsDir, 'settings.json')

    // 既存 settings.json があればマージ（profiles キーは deep merge）
    let existing: Record<string, unknown> = {}
    try {
      existing = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    } catch {
      // ignore — file doesn't exist or is malformed
    }
    const merged: Record<string, unknown> = { ...existing, ...settings }
    const profileKeys = [
      'terminal.integrated.profiles.osx',
      'terminal.integrated.profiles.linux',
    ]
    for (const key of profileKeys) {
      if (existing[key] && typeof existing[key] === 'object' && settings[key]) {
        merged[key] = { ...(existing[key] as Record<string, unknown>), ...(settings[key] as Record<string, unknown>) }
      }
    }
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2))

    logger.debug(`[vscode-server] Terminal sandbox configured at ${sandboxDir}`)
  }
}
