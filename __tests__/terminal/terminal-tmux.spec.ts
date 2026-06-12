/**
 * tmux 自動アタッチ機能のテスト。
 *
 * isTmuxAvailable() は fs.accessSync でバイナリパスを直接確認するため、
 * jest.mock('fs') で accessSync を差し替えてテスト間の tmux 有無を制御する。
 * spawnSync は PATH ベースのフォールバック検査にのみ使用される。
 * node-pty はモックしてリアル PTY を生成しない。
 */
import * as childProcess from 'child_process'
import * as nodePty from 'node-pty'

// fs モック: accessSync だけを jest.fn() に差し替え、他は実装を保持する
jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  accessSync: jest.fn(),
}))

// child_process モック（spawnSync: PATH フォールバック, execFile: kill-session）
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
import * as fs from 'fs'
import { TerminalSession } from '../../src/terminal/terminal-session'

const mockAccessSync = fs.accessSync as jest.Mock
const ENOENT = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

/** /usr/bin/tmux が実行可能なふりをする */
function setupTmuxAtStandardPath(): void {
  mockAccessSync.mockImplementation((p: fs.PathLike, mode?: number) => {
    if (p === '/usr/bin/tmux' && mode === fs.constants.X_OK) return
    throw ENOENT
  })
}

/** すべての標準パスに tmux が存在しないふりをする */
function setupTmuxNotFound(): void {
  mockAccessSync.mockImplementation(() => { throw ENOENT })
}

describe('tmux auto-attach', () => {
  const spawnSyncMock = childProcess.spawnSync as jest.Mock
  const execFileMock = childProcess.execFile as jest.Mock
  const ptySpawnMock = nodePty.spawn as jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    // デフォルト: /usr/bin/tmux が存在する環境をシミュレート
    setupTmuxAtStandardPath()
    // PATH フォールバックは標準パス検出後は呼ばれないが念のため設定
    spawnSyncMock.mockReturnValue({ status: 0, stdout: 'tmux 3.3a' })
  })

  describe('tmux 利用可能時（/usr/bin/tmux 存在）', () => {
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
      const onExitCall = mockPtyInstance.onExit.mock.calls[0]
      const onExitFn = onExitCall[0] as (e: { exitCode: number }) => void
      onExitFn({ exitCode: 0 })
      expect(execFileMock).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', `ais-${sessionId}`],
        expect.any(Function),
      )
    })

    it('isTmuxAvailable は /usr/bin/tmux の accessSync をチェックする', () => {
      new TerminalSession('access-check-test').kill()
      expect(mockAccessSync).toHaveBeenCalledWith('/usr/bin/tmux', fs.constants.X_OK)
    })

    it('/usr/bin/tmux が無くても /usr/local/bin/tmux で検出する', () => {
      mockAccessSync.mockImplementation((p: fs.PathLike, mode?: number) => {
        if (p === '/usr/local/bin/tmux' && mode === fs.constants.X_OK) return
        throw ENOENT
      })
      const session = new TerminalSession('local-bin-test')
      expect(ptySpawnMock).toHaveBeenCalledWith(
        'tmux',
        expect.arrayContaining(['new-session', '-A']),
        expect.any(Object),
      )
      session.kill()
    })
  })

  describe('tmux 未インストール時（フォールバック）', () => {
    beforeEach(() => {
      // 標準パスに tmux なし + PATH フォールバックも失敗
      setupTmuxNotFound()
      spawnSyncMock.mockReturnValue({ status: null, error: new Error('ENOENT') })
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

    it('PATH フォールバック (spawnSync) も試みる', () => {
      new TerminalSession('fallback-spawn-test').kill()
      expect(spawnSyncMock).toHaveBeenCalledWith('tmux', ['--version'], { encoding: 'utf-8' })
    })

    it('PATH フォールバックで検出した場合は tmux を起動する', () => {
      // 標準パスにはないが PATH には存在するケース（例: カスタムインストール）
      spawnSyncMock.mockReturnValue({ status: 0, stdout: 'tmux 3.3a' })
      const session = new TerminalSession('path-fallback-found-test')
      expect(ptySpawnMock).toHaveBeenCalledWith(
        'tmux',
        expect.arrayContaining(['new-session', '-A']),
        expect.any(Object),
      )
      session.kill()
    })
  })
})
