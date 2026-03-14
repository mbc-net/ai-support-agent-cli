import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { logger } from '../logger'
import { buildSafeEnv } from '../security'
import {
  MAX_CONCURRENT_SESSIONS,
  SESSION_IDLE_TIMEOUT_MS,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
} from './constants'

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

/**
 * プロジェクトディレクトリ外への移動を制限するシェル初期化スクリプトを生成する。
 * cd をラップし、移動先がプロジェクトディレクトリ配下でなければ拒否する。
 * PROMPT_COMMAND / precmd でも毎回チェックし、外部コマンド経由での移動も防止する。
 */
function buildSandboxInitScript(projectDir: string): string {
  // シェル変数に埋め込む際にシングルクォートをエスケープ
  const escaped = projectDir.replace(/'/g, "'\\''")
  // __SANDBOX_REAL は realpath で解決した物理パス。
  // pwd -P との比較に使い、シンボリックリンクの不一致を防ぐ。
  return `
__SANDBOX_DIR='${escaped}'
__SANDBOX_REAL="$(cd "\${__SANDBOX_DIR}" && pwd -P)"
__sandbox_is_inside() {
  local cur
  cur="$(pwd -P)"
  case "\${cur}" in
    "\${__SANDBOX_REAL}") return 0 ;;
    "\${__SANDBOX_REAL}/"*) return 0 ;;
    *) return 1 ;;
  esac
}
cd() {
  builtin cd "\$@" || return
  if ! __sandbox_is_inside; then
    echo "restricted: cannot leave project directory (\${__SANDBOX_REAL})" >&2
    builtin cd "\${__SANDBOX_DIR}"
    return 1
  fi
}
pushd() {
  builtin pushd "\$@" || return
  if ! __sandbox_is_inside; then
    builtin popd >/dev/null 2>&1
    echo "restricted: cannot leave project directory (\${__SANDBOX_REAL})" >&2
    return 1
  fi
}
popd() {
  builtin popd "\$@" || return
  if ! __sandbox_is_inside; then
    builtin cd "\${__SANDBOX_DIR}"
    echo "restricted: cannot leave project directory (\${__SANDBOX_REAL})" >&2
    return 1
  fi
}
exec() {
  echo "restricted: exec is disabled in sandbox mode" >&2
  return 1
}
__sandbox_check() {
  if ! __sandbox_is_inside; then
    builtin cd "\${__SANDBOX_DIR}" 2>/dev/null
  fi
}
# bash
if [ -n "\${BASH_VERSION}" ]; then
  PROMPT_COMMAND="__sandbox_check;\${PROMPT_COMMAND}"
fi
# zsh
if [ -n "\${ZSH_VERSION}" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null
  add-zsh-hook precmd __sandbox_check 2>/dev/null
fi
`
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
    const isZsh = shell.endsWith('/zsh') || shell.endsWith('/zsh5')
    if (isZsh) {
      // zsh: ZDOTDIR に .zshrc を配置し、元の .zshrc も読み込む
      const origZdotdir = (process.env.ZDOTDIR ?? process.env.HOME ?? '').replace(/'/g, "'\\''")
      const zshrc = `# Load original .zshrc\n[ -f '${origZdotdir}/.zshrc' ] && source '${origZdotdir}/.zshrc'\n${sandboxScript}`
      fs.writeFileSync(path.join(tmpDir, '.zshrc'), zshrc)
      env.ZDOTDIR = tmpDir
      shellArgs.push('--login')
    } else {
      // bash: --rcfile でサンドボックススクリプトを読み込む
      const bashrc = `# Load original .bashrc\n[ -f ~/.bashrc ] && source ~/.bashrc\n${sandboxScript}`
      const rcFile = path.join(tmpDir, '.bashrc')
      fs.writeFileSync(rcFile, bashrc)
      shellArgs.push('--rcfile', rcFile)
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

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>()
  private sessionCounter = 0

  createSession(options: TerminalSessionOptions = {}): TerminalSession | null {
    this.sessionCounter++
    const sessionId = `term-${Date.now()}-${this.sessionCounter}`
    return this.createSessionWithId(sessionId, options)
  }

  createSessionWithId(sessionId: string, options: TerminalSessionOptions = {}): TerminalSession | null {
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return null
    }

    const session = new TerminalSession(sessionId, options)

    session.onExit(() => {
      this.sessions.delete(sessionId)
    })

    session.setOnIdleTimeout(() => {
      session.kill()
      this.sessions.delete(sessionId)
    })

    this.sessions.set(sessionId, session)
    return session
  }

  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId)
  }

  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.kill()
    this.sessions.delete(sessionId)
    return true
  }

  listSessions(): TerminalSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => s.getInfo())
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.kill()
    }
    this.sessions.clear()
  }

  get size(): number {
    return this.sessions.size
  }
}
