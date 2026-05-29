import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { filterEnvVarsOverride } from '../env-vars-filter'
import { logger } from '../logger'
import { buildSafeEnv } from '../security'
import { ensureClaudeJsonIntegrity } from '../utils/claude-config-validator'
import { ensureClaudeJsonOAuthAccount } from '../utils/claude-json-oauth-sync'
import { getErrorMessage } from '../utils'
import {
  SESSION_IDLE_TIMEOUT_MS,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
} from './constants'
import {
  buildSandboxInitScript,
  buildBashRcContent,
  buildZshRcContent,
  isZshShell,
} from './sandbox-init-script'

/**
 * Minimal subset of node-pty's IPty interface used by TerminalSession.
 * Defined locally so that tsc does not require node-pty's type declarations
 * at compile time (node-pty is an optionalDependency whose native build may
 * be absent in CI or non-desktop environments).
 */
interface IPty {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (e: { exitCode: number; signal?: number }) => void) => void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string>
    },
  ): IPty
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pty: PtyModule | null = null
let ptyLoadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty') as PtyModule
} catch (e: unknown) /* istanbul ignore next -- only when native build fails */ {
  ptyLoadError = getErrorMessage(e)
  logger.debug(`[terminal] node-pty is not available: ${ptyLoadError}`)
}

/**
 * node-pty が利用可能か確認する
 */
export function isNodePtyAvailable(): boolean {
  return pty !== null
}

export interface TerminalSessionOptions {
  cols?: number
  rows?: number
  cwd?: string
  /**
   * Web 設定（CLAUDE_CODE# / ENV# 由来）から流れてくる env オーバーレイ。
   * PTY 環境に最後にマージされ、ユーザーが対話シェルから `claude` を起動した
   * 際にも Web の `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` /
   * `ANTHROPIC_MODEL` 等が効くようにする。
   * 含まれないキーは PTY が継承する process.env をそのまま残す。
   */
  envVarsOverride?: Record<string, string>
}

export interface TerminalSessionInfo {
  sessionId: string
  pid: number
  cols: number
  rows: number
  cwd: string
  createdAt: number
  lastActivity: number
}

type DataCallback = (data: string) => void
type ExitCallback = (code: number | null) => void

/**
 * SSH キーの環境変数名
 *
 * API サーバーが base64 エンコードされた PEM 秘密鍵をこの変数名で送ってくる。
 * TerminalSession はこれを検出してファイルに書き出し、GIT_SSH_COMMAND を設定する。
 * この変数自体は PTY には渡さない（ファイルパスが GIT_SSH_COMMAND 経由で参照される）。
 */
export const GIT_SSH_KEY_ENV_NAME = 'GIT_SSH_KEY_CONTENT_BASE64'

export class TerminalSession {
  readonly sessionId: string
  readonly pid: number
  cols: number
  rows: number
  readonly cwd: string
  readonly createdAt: number
  private lastActivity: number
  private readonly ptyProcess: IPty
  private sandboxTmpDir: string | null = null
  private sshKeyFile: string | null = null
  private dataCallback: DataCallback | null = null
  private exitCallback: ExitCallback | null = null
  private exited = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private onIdleTimeout: (() => void) | null = null

  /**
   * 過去の terminal-sandbox-* ディレクトリを一括削除する。
   *
   * 通常は session 終了時 (kill / onExit) に `cleanupTmpDir` で削除されるが、
   * agent process が SIGKILL / クラッシュした場合は孤立した sandbox dir が
   * `/tmp` に残る。長期稼働で累積すると ENOSPC を引き起こすため、起動時に
   * クリーンアップする。
   *
   * デフォルトは 24 時間以上前の sandbox のみ削除。`maxAgeMs=0` で全削除。
   *
   * @param maxAgeMs 削除対象とする経過時間 (ms)。0 で全削除
   * @returns 削除した件数
   */
  static cleanupStaleSandboxes(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const tmpDir = os.tmpdir()
    let removed = 0
    let entries: string[]
    try {
      entries = fs.readdirSync(tmpDir)
    } catch {
      return 0
    }
    const now = Date.now()
    for (const name of entries) {
      if (!name.startsWith('terminal-sandbox-')) continue
      const fullPath = path.join(tmpDir, name)
      try {
        const stat = fs.statSync(fullPath)
        if (maxAgeMs > 0 && now - stat.mtimeMs < maxAgeMs) continue
        fs.rmSync(fullPath, { recursive: true, force: true })
        removed++
      } catch {
        // ignore individual failures
      }
    }
    return removed
  }

  constructor(sessionId: string, options: TerminalSessionOptions = {}) {
    /* istanbul ignore if -- only when native build fails */
    if (!pty) {
      throw new Error(
        `Terminal functionality is not available: node-pty failed to load. ${ptyLoadError ?? 'Unknown error'}`,
      )
    }

    this.sessionId = sessionId
    this.cols = options.cols ?? TERMINAL_DEFAULT_COLS
    this.rows = options.rows ?? TERMINAL_DEFAULT_ROWS
    this.cwd = options.cwd ?? process.cwd()
    this.createdAt = Date.now()
    this.lastActivity = this.createdAt

    const shell = process.env.SHELL ?? '/bin/bash'
    const safeEnv = buildSafeEnv()
    const env: Record<string, string> = {
      ...safeEnv,
      TERM: 'xterm-256color',
    }
    // node-pty requires PATH to locate spawn-helper
    if (!env.PATH) {
      env.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    }

    // サンドボックス初期化スクリプトを一時ファイルに書き出す
    const sandboxScript = buildSandboxInitScript(path.resolve(this.cwd))
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-sandbox-'))
    this.sandboxTmpDir = tmpDir

    const shellArgs: string[] = []
    if (isZshShell(shell)) {
      fs.writeFileSync(path.join(tmpDir, '.zshrc'), buildZshRcContent(sandboxScript))
      env.ZDOTDIR = tmpDir
      shellArgs.push('--login')
    } else {
      fs.writeFileSync(path.join(tmpDir, '.bashrc'), buildBashRcContent(sandboxScript))
      shellArgs.push('--rcfile', path.join(tmpDir, '.bashrc'))
    }

    // Web 設定（CLAUDE_CODE# / ENV#）由来の env オーバーレイを最後にマージ。
    // 含まれないキーは safeEnv (= process.env から PATH/TERM 等を引き継いだもの) が残る。
    //
    // 二層防御: api 側 AgentEnvVarsService が既に denylist フィルタを通している
    // はずだが、agent 側でも filterEnvVarsOverride を通して PATH/ZDOTDIR 等の
    // sandbox 関連キーが上書きされないことを保証する。これにより api 側の
    // regression や別経路からの流入があっても sandbox を維持できる。
    //
    // GIT_SSH_KEY_CONTENT_BASE64 は特別扱い: フィルタに通す前に取り出し、
    // ファイルに書き出して GIT_SSH_COMMAND として設定する。
    const rawOverride = options.envVarsOverride ?? {}
    const sshKeyBase64 = rawOverride[GIT_SSH_KEY_ENV_NAME]
    const overrideWithoutSshKey: Record<string, string> = { ...rawOverride }
    delete overrideWithoutSshKey[GIT_SSH_KEY_ENV_NAME]

    if (sshKeyBase64) {
      try {
        const pemContent = Buffer.from(sshKeyBase64, 'base64').toString('utf-8')
        const sshKeyPath = path.join(os.tmpdir(), `ssh-key-${sessionId}`)
        fs.writeFileSync(sshKeyPath, pemContent, { mode: 0o600 })
        this.sshKeyFile = sshKeyPath
        env.GIT_SSH_COMMAND = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`
        logger.debug(`[terminal:${sessionId}] SSH key configured for git operations`)
      } catch {
        logger.warn(`[terminal:${sessionId}] Failed to set up SSH key for git; continuing without SSH key`)
      }
    }

    const filteredOverride = filterEnvVarsOverride(overrideWithoutSshKey, {
      prefix: `[terminal:${sessionId}]`,
    })
    for (const [key, value] of Object.entries(filteredOverride)) {
      env[key] = value
    }

    // Claude Code 対話モードは ~/.claude.json の oauthAccount キーが
    // 存在しないと CLAUDE_CODE_OAUTH_TOKEN env を持っていても /login プロンプトを出す。
    // PTY 起動前に、(1) JSON 破損があれば backup から復元、(2) oauthAccount placeholder
    // を確保する。両者は ~/.claude.json を触るため順序が重要 (integrity 先 → oauth-sync 後)。
    ensureClaudeJsonIntegrity()
    ensureClaudeJsonOAuthAccount(filteredOverride, {
      prefix: `[terminal:${sessionId}]`,
    })

    this.ptyProcess = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    })

    this.pid = this.ptyProcess.pid

    this.ptyProcess.onData((data: string) => {
      this.touchActivity()
      if (this.dataCallback) {
        this.dataCallback(data)
      }
    })

    this.ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      this.exited = true
      this.clearIdleTimer()
      this.cleanupTmpDir()
      if (this.exitCallback) {
        this.exitCallback(exitCode)
      }
    })

    this.resetIdleTimer()
  }

  onData(callback: DataCallback): void {
    this.dataCallback = callback
  }

  onExit(callback: ExitCallback): void {
    this.exitCallback = callback
  }

  setOnIdleTimeout(callback: () => void): void {
    this.onIdleTimeout = callback
  }

  write(data: string): void {
    if (this.exited) return
    this.touchActivity()
    this.ptyProcess.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return
    this.cols = cols
    this.rows = rows
    this.ptyProcess.resize(cols, rows)
    this.touchActivity()
  }

  kill(): void {
    if (this.exited) return
    this.clearIdleTimer()
    this.ptyProcess.kill()
    this.cleanupTmpDir()
  }

  private cleanupTmpDir(): void {
    if (this.sandboxTmpDir) {
      try {
        fs.rmSync(this.sandboxTmpDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
      this.sandboxTmpDir = null
    }
    if (this.sshKeyFile) {
      try {
        fs.rmSync(this.sshKeyFile, { force: true })
      } catch {
        // ignore cleanup errors
      }
      this.sshKeyFile = null
    }
  }

  isAlive(): boolean {
    return !this.exited
  }

  getInfo(): TerminalSessionInfo {
    return {
      sessionId: this.sessionId,
      pid: this.pid,
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
    }
  }

  private touchActivity(): void {
    this.lastActivity = Date.now()
    this.resetIdleTimer()
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      if (this.onIdleTimeout) {
        this.onIdleTimeout()
      } else {
        this.kill()
      }
    }, SESSION_IDLE_TIMEOUT_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
