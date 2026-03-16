import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { logger } from '../logger'
import { buildSafeEnv } from '../security'
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
 * node-pty を遅延ロードする。
 * optionalDependency のため、ネイティブビルドが失敗した環境では利用不可。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pty: typeof import('node-pty') | null = null
let ptyLoadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch (e) /* istanbul ignore next -- only when native build fails */ {
  ptyLoadError = e instanceof Error ? e.message : String(e)
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

export class TerminalSession {
  readonly sessionId: string
  readonly pid: number
  cols: number
  rows: number
  readonly cwd: string
  readonly createdAt: number
  private lastActivity: number
  private readonly ptyProcess: import('node-pty').IPty
  private sandboxTmpDir: string | null = null
  private dataCallback: DataCallback | null = null
  private exitCallback: ExitCallback | null = null
  private exited = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private onIdleTimeout: (() => void) | null = null

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
