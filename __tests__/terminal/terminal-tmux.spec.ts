/**
 * tmux 自動アタッチ機能のテスト。
 *
 * child_process をモックして tmux の有無をテスト間でコントロールする。
 * node-pty はモックしてリアル PTY を生成しない。
 */
import * as childProcess from 'child_process'
import * as nodePty from 'node-pty'

// child_process モック（spawnSync: tmux --version チェック, execFile: kill-session）
jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
  execFile: jest.fn((_cmd: string, _args: string[], cb?: (err: unknown) => void) => {
    cb?.(null)
    return {}
  }),
}))

// node-pty モック（リアルプロセスを生成しない）
class MockPty {
  pid = 99999
  onData = jest.fn()
  onExit = jest.fn()
  write = jest.fn()
  resize = jest.fn()
  kill = jest.fn()
}

let mockPtyInstance: MockPty
jest.mock('node-pty', () => ({
  spawn: jest.fn(() => {
    mockPtyInstance = new MockPty()
    return mockPtyInstance
  }),
}))

// モック後にインポート
import { TerminalSession } from '../../src/terminal/terminal-session'

const TMUX_AVAILABLE = { status: 0, stdout: 'tmux 3.3a' }
const TMUX_NOT_FOUND = { status: null, error: new Error('ENOENT') }

describe('tmux auto-attach', () => {
  const spawnSyncMock = childProcess.spawnSync as jest.Mock
  const execFileMock = childProcess.execFile as jest.Mock
  const ptySpawnMock = nodePty.spawn as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    spawnSyncMock.mockReturnValue(TMUX_AVAILABLE)
  })

  afterEach(() => {
    // モックの kill はイベントを発火しないため exited フラグが立たない。
    // cleanupTmpDir の二重呼び出しは無害（null ガード済み）。
  })

  describe('tmux 利用可能時', () => {
    it('pty.spawn を tmux で呼び出す', () => {
      const session = new TerminalSession('test-session-001')
      expect(ptySpawnMock).toHaveBeenCalledWith(
        'tmux',
        expect.arrayContaining(['new-session', '-A']),
        expect.any(Object),
      )
      session.kill()
    })

    it('セッション名が ais-<sessionId> になる', () => {
      const sessionId = '879d99b5-dd61-49b5-b144-e5d4e9a2b4dc'
      const session = new TerminalSession(sessionId)
      const [, args] = ptySpawnMock.mock.calls[0]
      const sIdx = (args as string[]).indexOf('-s')
      expect(sIdx).toBeGreaterThan(-1)
      expect((args as string[])[sIdx + 1]).toBe(`ais-${sessionId}`)
      session.kill()
    })

    it('cols/rows を -x/-y で tmux に渡す', () => {
      const session = new TerminalSession('dim-test', { cols: 120, rows: 40 })
      const [, args] = ptySpawnMock.mock.calls[0]
      expect(args).toContain('-x')
      expect(args).toContain('120')
      expect(args).toContain('-y')
      expect(args).toContain('40')
      session.kill()
    })

    it('env.SHELL がシェルラッパーパスに設定される', () => {
      const session = new TerminalSession('shell-wrapper-test')
      const [, , opts] = ptySpawnMock.mock.calls[0]
      expect((opts as { env: Record<string, string> }).env.SHELL).toMatch(/shell-wrapper$/)
      session.kill()
    })

    it('kill() 時に tmux kill-session を呼び出す', () => {
      const sessionId = 'kill-test-abc'
      const session = new TerminalSession(sessionId)
      session.kill()
      expect(execFileMock).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', `ais-${sessionId}`],
        expect.any(Function),
      )
    })

    it('kill() を 2 回呼んでも tmux kill-session は 1 回だけ', () => {
      const session = new TerminalSession('double-kill-test')
      session.kill()
      session.kill()
      const killCalls = execFileMock.mock.calls.filter(
        ([cmd, args]: [string, string[]]) => cmd === 'tmux' && args[0] === 'kill-session',
      )
      expect(killCalls).toHaveLength(1)
    })

    it('PTY onExit 時に tmux kill-session を呼び出す', () => {
      const sessionId = 'exit-test-xyz'
      const session = new TerminalSession(sessionId)
      // onExit コールバックを手動で発火
      const onExitCall = mockPtyInstance.onExit.mock.calls[0]
      const onExitFn = onExitCall[0] as (e: { exitCode: number }) => void
      onExitFn({ exitCode: 0 })
      expect(execFileMock).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', `ais-${sessionId}`],
        expect.any(Function),
      )
      // kill() 後は exited=true なので safe
    })
  })

  describe('tmux 未インストール時（フォールバック）', () => {
    beforeEach(() => {
      spawnSyncMock.mockReturnValue(TMUX_NOT_FOUND)
    })

    it('pty.spawn をシェルで呼び出す（tmux ではない）', () => {
      const shell = process.env.SHELL ?? '/bin/bash'
      const session = new TerminalSession('fallback-test')
      const [spawnedFile] = ptySpawnMock.mock.calls[0]
      expect(spawnedFile).toBe(shell)
      session.kill()
    })

    it('kill() 時に tmux kill-session を呼び出さない', () => {
      const session = new TerminalSession('no-tmux-kill-test')
      session.kill()
      const killCalls = execFileMock.mock.calls.filter(
        ([cmd, args]: [string, string[]]) => cmd === 'tmux' && args[0] === 'kill-session',
      )
      expect(killCalls).toHaveLength(0)
    })
  })
})
