import { ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as path from 'path'

import { filterEnvVarsOverride } from '../env-vars-filter'
import { logger } from '../logger'
import { ensureClaudeJsonIntegrity } from '../utils/claude-config-validator'
import { ensureClaudeJsonOAuthAccount } from '../utils/claude-json-oauth-sync'
import {
  buildSandboxInitScript,
  buildBashRcContent,
  buildZshRcContent,
  buildOpenFolderDisableKeybindings,
  isZshShell,
} from '../terminal/sandbox-init-script'
import { getErrorMessage, readJsonSync, sleep } from '../utils'

import {
  VSCODE_DEFAULT_PORT,
  VSCODE_BIND_HOST,
  VSCODE_IDLE_TIMEOUT_MS,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_REQUEST_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  VSCODE_SIGKILL_DELAY_MS,
} from './constants'

export interface VsCodeServerOptions {
  projectDir: string
  port?: number
  /**
   * Web 設定 (CLAUDE_CODE# / ENV#) 由来の env オーバーレイ。code-server プロセス
   * の env にマージされ、VS Code 内蔵ターミナルから起動した子プロセスにも
   * 継承される。これにより VS Code ターミナルで `claude` を起動した際にも
   * Web 設定が反映される。
   */
  envVarsOverride?: Record<string, string>
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
  private port: number
  private readonly requestedPort: number
  private readonly projectDir: string
  private readonly envVarsOverride: Record<string, string> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(options: VsCodeServerOptions) {
    this.requestedPort = options.port ?? VSCODE_DEFAULT_PORT
    this.port = this.requestedPort
    this.projectDir = options.projectDir
    this.envVarsOverride = options.envVarsOverride
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

    // 要求ポートが使用中なら空きポートを自動取得
    this.port = await this.resolveAvailablePort(this.requestedPort)

    logger.info(`[vscode-server] Starting code-server on ${VSCODE_BIND_HOST}:${this.port}`)

    try {
      this.setupTerminalSandbox()
    } catch (error) {
      logger.warn(`[vscode-server] Failed to setup terminal sandbox: ${getErrorMessage(error)}`)
    }

    // 注: process.env をベースに XDG → envVarsOverride の順で上書き
    // envVarsOverride を最後にマージすることで Web 設定が host env を上書き
    //
    // 二層防御: api 側 denylist で PATH/XDG_*/ZDOTDIR 等は弾かれる想定だが、
    // agent 側でも filterEnvVarsOverride を通して sandbox 関連キーが
    // 上書きされないことを保証する。特に XDG_DATA_HOME / XDG_CONFIG_HOME は
    // VS Code 内蔵ターミナルの sandbox プロファイル / ワークスペース信頼設定の
    // アンカーになっているため、上書きされると sandbox が外れる。
    const codeServerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // code-server が XDG ディレクトリを使うよう設定
      XDG_DATA_HOME: `${this.projectDir}/.vscode-server/data`,
      XDG_CONFIG_HOME: `${this.projectDir}/.vscode-server/config`,
    }
    const filteredOverride = filterEnvVarsOverride(this.envVarsOverride, {
      prefix: '[vscode-server]',
    })
    for (const [key, value] of Object.entries(filteredOverride)) {
      codeServerEnv[key] = value
    }

    // Claude Code 対話モード (VS Code 内蔵ターミナルから claude を実行) は
    // ~/.claude.json の oauthAccount キーが存在しないと CLAUDE_CODE_OAUTH_TOKEN env を
    // 持っていても /login プロンプトを出す。code-server 起動前に、
    // (1) JSON 破損があれば backup から復元、(2) oauthAccount placeholder を確保。
    ensureClaudeJsonIntegrity()
    ensureClaudeJsonOAuthAccount(filteredOverride, {
      prefix: '[vscode-server]',
    })

    this.process = spawn('code-server', [
      '--bind-addr', `${VSCODE_BIND_HOST}:${this.port}`,
      '--auth', 'none',
      '--disable-telemetry',
      '--disable-update-check',
      '--disable-getting-started-override',
      this.projectDir,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: codeServerEnv,
    })

    // spawn の error イベント（コマンド未発見等）を検知するための Promise
    const proc = this.process
    const spawnError = new Promise<never>((_, reject) => {
      proc.on('error', (err) => {
        logger.error(`[vscode-server] Failed to spawn: ${getErrorMessage(err)}`)
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
      // SIGKILL_DELAY_MS 後に強制終了
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL')
        }
      }, VSCODE_SIGKILL_DELAY_MS)
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
    }, VSCODE_IDLE_TIMEOUT_MS).unref()
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
      req.setTimeout(HEALTH_CHECK_REQUEST_TIMEOUT_MS, () => {
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
        await sleep(500)
      }
    }
    throw new Error(`code-server failed to start within ${STARTUP_TIMEOUT_MS}ms`)
  }

  /**
   * ポートが使用可能かチェックし、使用中なら空きポートを自動取得する
   */
  private async resolveAvailablePort(preferredPort: number): Promise<number> {
    const isAvailable = await this.checkPortAvailable(preferredPort)
    if (isAvailable) return preferredPort

    // ポート 0 で OS に空きポートを割り当てさせる
    logger.info(`[vscode-server] Port ${preferredPort} is in use, finding available port...`)
    return new Promise<number>((resolve, reject) => {
      const server = net.createServer()
      server.listen(0, VSCODE_BIND_HOST, () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          const port = addr.port
          server.close(() => resolve(port))
        } else {
          server.close(() => reject(new Error('Failed to get assigned port')))
        }
      })
      server.on('error', reject)
    })
  }

  private checkPortAvailable(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, VSCODE_BIND_HOST, () => {
        server.close(() => resolve(true))
      })
    })
  }

  /**
   * code-server のターミナルにサンドボックスを適用する。
   * - bash/zsh 用の rc ファイルを生成し、サンドボックススクリプトを注入
   * - settings.json でサンドボックス付きターミナルプロファイルをデフォルトに設定
   * - Workspace Trust を有効化して別フォルダを開いた場合に restricted mode にする
   * - File メニュー非表示 + Open Folder 系キーバインド無効化
   */
  private setupTerminalSandbox(): void {
    const resolvedDir = path.resolve(this.projectDir)
    const sandboxDir = path.join(resolvedDir, '.vscode-server', 'terminal-sandbox')
    fs.mkdirSync(sandboxDir, { recursive: true })

    this.writeSandboxRcFiles(sandboxDir, resolvedDir)
    const settings = this.buildSandboxSettings(sandboxDir, resolvedDir)

    const settingsDir = path.join(resolvedDir, '.vscode-server', 'data', 'code-server', 'User')
    this.writeUserConfig(settingsDir, settings)

    logger.debug(`[vscode-server] Terminal sandbox configured at ${sandboxDir}`)
  }

  /**
   * bash/zsh 用の rc ファイルを生成する
   */
  private writeSandboxRcFiles(sandboxDir: string, resolvedDir: string): void {
    const sandboxScript = buildSandboxInitScript(resolvedDir)
    fs.writeFileSync(path.join(sandboxDir, '.bashrc'), buildBashRcContent(sandboxScript))
    fs.writeFileSync(path.join(sandboxDir, '.zshrc'), buildZshRcContent(sandboxScript))
  }

  /**
   * settings.json のオブジェクトを構築する
   */
  private buildSandboxSettings(sandboxDir: string, resolvedDir: string): Record<string, unknown> {
    const defaultProfile = isZshShell() ? 'sandbox-zsh' : 'sandbox-bash'

    const sandboxBashProfile = {
      path: '/bin/bash',
      args: ['--rcfile', path.join(sandboxDir, '.bashrc')],
    }
    const sandboxZshProfile = {
      path: '/bin/zsh',
      args: ['--login'],
      env: { ZDOTDIR: sandboxDir },
    }

    return {
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
      'window.menuBarVisibility': 'hidden',
    }
  }

  /**
   * settings.json マージ書き出し + keybindings.json 生成
   */
  private writeUserConfig(settingsDir: string, settings: Record<string, unknown>): void {
    fs.mkdirSync(settingsDir, { recursive: true })
    const settingsPath = path.join(settingsDir, 'settings.json')

    // 既存 settings.json があればマージ（profiles キーは deep merge）
    let existing: Record<string, unknown> = {}
    try {
      existing = readJsonSync<Record<string, unknown>>(settingsPath)
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

    // keybindings.json — Open Folder 系キーバインドを無効化
    // サンドボックス管理下のため、ユーザーカスタムキーバインドは想定せず毎回上書きする
    const keybindingsPath = path.join(settingsDir, 'keybindings.json')
    const keybindings = buildOpenFolderDisableKeybindings()
    fs.writeFileSync(keybindingsPath, JSON.stringify(keybindings, null, 2))
  }
}
