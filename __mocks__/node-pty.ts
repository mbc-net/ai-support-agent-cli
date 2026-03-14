/**
 * Jest manual mock for node-pty.
 *
 * node-pty is a native module that requires platform-specific binaries.
 * In CI (GitHub Actions Linux), the pre-built binary may not be available,
 * causing all test suites that transitively import it to fail.
 *
 * This mock provides a minimal stub that satisfies the IPty interface
 * used by TerminalSession.
 */

const EventEmitter = require('events')

let pidCounter = 1000

class MockPty extends EventEmitter {
  pid: number
  cols: number
  rows: number
  process: string
  handleFlowControl: boolean

  private _killed = false
  private _onDataCallback: ((data: string) => void) | null = null
  private _onExitCallback: ((e: { exitCode: number; signal?: number }) => void) | null = null

  constructor(
    _file: string,
    _args: string[],
    options: { cols?: number; rows?: number } = {},
  ) {
    super()
    this.pid = pidCounter++
    this.cols = options.cols ?? 80
    this.rows = options.rows ?? 24
    this.process = _file
    this.handleFlowControl = false
  }

  onData(callback: (data: string) => void): { dispose: () => void } {
    this._onDataCallback = callback
    return { dispose: () => { this._onDataCallback = null } }
  }

  onExit(callback: (e: { exitCode: number; signal?: number }) => void): { dispose: () => void } {
    this._onExitCallback = callback
    return { dispose: () => { this._onExitCallback = null } }
  }

  write(data: string): void {
    if (this._killed) return
    // Simulate echo of input back as output
    if (this._onDataCallback) {
      process.nextTick(() => {
        if (this._onDataCallback) {
          this._onDataCallback(data)
        }
      })
    }
    // Handle exit command
    if (data.trim() === 'exit') {
      process.nextTick(() => {
        this._killed = true
        if (this._onExitCallback) {
          this._onExitCallback({ exitCode: 0 })
        }
      })
    }
  }

  resize(cols: number, rows: number): void {
    if (this._killed) return
    this.cols = cols
    this.rows = rows
  }

  kill(_signal?: string): void {
    if (this._killed) return
    this._killed = true
    process.nextTick(() => {
      if (this._onExitCallback) {
        this._onExitCallback({ exitCode: 0 })
      }
    })
  }

  pause(): void { /* no-op */ }
  resume(): void { /* no-op */ }
  clear(): void { /* no-op */ }
}

function spawn(
  file: string,
  args: string[],
  options: { cols?: number; rows?: number; cwd?: string; env?: Record<string, string>; name?: string } = {},
): MockPty {
  return new MockPty(file, args, options)
}

module.exports = { spawn }
