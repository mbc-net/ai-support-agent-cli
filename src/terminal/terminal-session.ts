import { ChildProcess, spawn } from 'child_process'

import { buildSafeEnv } from '../security'

import {
  MAX_CONCURRENT_SESSIONS,
  SESSION_IDLE_TIMEOUT_MS,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
} from './constants'

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
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly createdAt: number
  private lastActivity: number
  private readonly process: ChildProcess
  private dataCallback: DataCallback | null = null
  private exitCallback: ExitCallback | null = null
  private exited = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private onIdleTimeout: (() => void) | null = null

  constructor(sessionId: string, options: TerminalSessionOptions = {}) {
    this.sessionId = sessionId
    this.cols = options.cols ?? TERMINAL_DEFAULT_COLS
    this.rows = options.rows ?? TERMINAL_DEFAULT_ROWS
    this.cwd = options.cwd ?? process.cwd()
    this.createdAt = Date.now()
    this.lastActivity = this.createdAt

    const env = {
      ...buildSafeEnv(),
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
      TERM: 'xterm-256color',
    }

    this.process = spawn('/bin/bash', ['--login'], {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.pid = this.process.pid ?? 0

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.touchActivity()
      if (this.dataCallback) {
        this.dataCallback(chunk.toString('utf-8'))
      }
    })

    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.touchActivity()
      if (this.dataCallback) {
        this.dataCallback(chunk.toString('utf-8'))
      }
    })

    this.process.on('exit', (code) => {
      this.exited = true
      this.clearIdleTimer()
      if (this.exitCallback) {
        this.exitCallback(code)
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
    this.process.stdin?.write(data)
  }

  resize(cols: number, rows: number): void {
    // child_process does not support resize natively;
    // update stored dimensions for info purposes
    (this as { cols: number }).cols = cols;
    (this as { rows: number }).rows = rows
    this.touchActivity()
  }

  kill(): void {
    if (this.exited) return
    this.clearIdleTimer()
    this.process.kill('SIGTERM')
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
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return null
    }

    this.sessionCounter++
    const sessionId = `term-${Date.now()}-${this.sessionCounter}`
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
