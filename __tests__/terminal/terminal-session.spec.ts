import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { EventEmitter } from 'events'

import * as constants from '../../src/terminal/constants'
import { TerminalSession, isNodePtyAvailable } from '../../src/terminal/terminal-session'
import { TerminalSessionManager } from '../../src/terminal/terminal-session-manager'

const { MAX_CONCURRENT_SESSIONS } = constants

// Mock node-pty to avoid spawning real pty processes that linger after tests
// (real pty processes on Linux/GitHub Actions cause Jest to hang at shutdown)
type DataHandler = (data: string) => void
type ExitHandler = (info: { exitCode: number; signal?: number }) => void

class MockPty extends EventEmitter {
  pid = 12345
  cols = 80
  rows = 24
  private _dataHandler: DataHandler | null = null
  private _exitHandler: ExitHandler | null = null

  onData(handler: DataHandler) {
    this._dataHandler = handler
  }

  onExit(handler: ExitHandler) {
    this._exitHandler = handler
  }

  write(data: string) {
    // Simulate shell: emit data back, and respond to 'exit\n' with exit event
    if (this._dataHandler) {
      this._dataHandler(data)
    }
    if (data.trim() === 'exit') {
      setImmediate(() => this._exitHandler?.({ exitCode: 0 }))
    }
    // Simulate command-not-found for unknown commands
    if (data.includes('no_such_command_xyz') && this._dataHandler) {
      setImmediate(() => this._dataHandler?.(`bash: no_such_command_xyz: command not found\r\n`))
    }
  }

  resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
  }

  kill() {
    setImmediate(() => this._exitHandler?.({ exitCode: 0 }))
  }
}

let mockPtyInstance: MockPty

jest.mock('node-pty', () => ({
  spawn: jest.fn(() => {
    mockPtyInstance = new MockPty()
    return mockPtyInstance
  }),
}))

describe('isNodePtyAvailable', () => {
  it('should return true when node-pty is installed', () => {
    expect(isNodePtyAvailable()).toBe(true)
  })
})

describe('TerminalSession', () => {
  let session: TerminalSession

  afterEach(() => {
    if (session?.isAlive()) {
      session.kill()
    }
  })

  it('should create a session with default options', () => {
    session = new TerminalSession('test-1')
    expect(session.sessionId).toBe('test-1')
    expect(session.cols).toBe(80)
    expect(session.rows).toBe(24)
    expect(session.pid).toBeGreaterThan(0)
    expect(session.isAlive()).toBe(true)
  })

  it('should create a session with custom options', () => {
    session = new TerminalSession('test-2', { cols: 120, rows: 40, cwd: '/tmp' })
    expect(session.cols).toBe(120)
    expect(session.rows).toBe(40)
    expect(session.cwd).toBe('/tmp')
  })

  it('should receive stdout data', (done) => {
    session = new TerminalSession('test-3')
    session.onData((data) => {
      expect(typeof data).toBe('string')
      done()
    })
    session.write('echo hello\n')
  })

  it('should handle exit', (done) => {
    session = new TerminalSession('test-4')
    session.onExit((code) => {
      expect(typeof code).toBe('number')
      expect(session.isAlive()).toBe(false)
      done()
    })
    session.write('exit\n')
  })

  it('should update dimensions on resize', () => {
    session = new TerminalSession('test-5')
    session.resize(200, 50)
    expect(session.cols).toBe(200)
    expect(session.rows).toBe(50)
  })

  it('should return session info', () => {
    session = new TerminalSession('test-6')
    const info = session.getInfo()
    expect(info.sessionId).toBe('test-6')
    expect(info.pid).toBeGreaterThan(0)
    expect(info.createdAt).toBeLessThanOrEqual(Date.now())
    expect(info.lastActivity).toBeLessThanOrEqual(Date.now())
  })

  it('should kill session', (done) => {
    session = new TerminalSession('test-7')
    expect(session.isAlive()).toBe(true)
    session.onExit(() => {
      expect(session.isAlive()).toBe(false)
      done()
    })
    session.kill()
  })

  it('should not write after kill', (done) => {
    session = new TerminalSession('test-8')
    session.onExit(() => {
      // After exit, write should be a no-op (no errors)
      session.write('should not error\n')
      done()
    })
    session.kill()
  })

  it('should not kill twice', (done) => {
    session = new TerminalSession('test-9')
    session.onExit(() => {
      // Second kill should be a no-op
      session.kill()
      done()
    })
    session.kill()
  })

  it('should receive stderr data via onData', (done) => {
    session = new TerminalSession('test-stderr')
    session.onData((data) => {
      if (data.includes('no_such_command_xyz')) {
        done()
      }
    })
    session.write('no_such_command_xyz 2>&1\n')
  })

  it('should trigger idle timeout and kill session', (done) => {
    const origTimeout = constants.SESSION_IDLE_TIMEOUT_MS
    Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: 50, writable: true })

    session = new TerminalSession('test-idle')
    session.onExit(() => {
      Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: origTimeout, writable: true })
      done()
    })
    // Don't write anything — session should idle-timeout and kill itself
  })

  describe('envVarsOverride', () => {
    it('passes envVarsOverride values to pty.spawn env', () => {
      const pty = require('node-pty')
      const spawnSpy = pty.spawn as jest.Mock
      spawnSpy.mockClear()

      session = new TerminalSession('test-env-1', {
        envVarsOverride: {
          ANTHROPIC_API_KEY: 'sk-from-web',
          ANTHROPIC_MODEL: 'claude-sonnet-4-6',
        },
      })

      const call = spawnSpy.mock.calls[0]
      const env = call[2].env as Record<string, string>
      expect(env.ANTHROPIC_API_KEY).toBe('sk-from-web')
      expect(env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
      // TERM などの safeEnv キーも残っている
      expect(env.TERM).toBe('xterm-256color')
    })

    it('skips non-string and empty values', () => {
      const pty = require('node-pty')
      const spawnSpy = pty.spawn as jest.Mock
      spawnSpy.mockClear()

      session = new TerminalSession('test-env-2', {
        envVarsOverride: {
          VALID: 'ok',
          EMPTY: '',
          NULLY: null as unknown as string,
          NUMERIC: 42 as unknown as string,
          BOOLY: true as unknown as string,
        },
      })

      const env = spawnSpy.mock.calls[0][2].env as Record<string, string>
      expect(env.VALID).toBe('ok')
      expect(env.EMPTY).toBeUndefined()
      expect(env.NULLY).toBeUndefined()
      expect(env.NUMERIC).toBeUndefined()
      expect(env.BOOLY).toBeUndefined()
    })

    it('does not change spawn env when envVarsOverride is absent', () => {
      const pty = require('node-pty')
      const spawnSpy = pty.spawn as jest.Mock
      spawnSpy.mockClear()

      session = new TerminalSession('test-env-3')

      const env = spawnSpy.mock.calls[0][2].env as Record<string, string>
      // envVarsOverride 未指定でもエラーにならない
      expect(env.TERM).toBe('xterm-256color')
      expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    })

    it('envVarsOverride overrides safeEnv values for the same key (non-protected)', () => {
      const pty = require('node-pty')
      const spawnSpy = pty.spawn as jest.Mock
      spawnSpy.mockClear()

      // TERM は denylist に含まれないため上書き可能。
      // 一方 PATH/ZDOTDIR/XDG_* は filterEnvVarsOverride で弾かれる (別テスト)。
      session = new TerminalSession('test-env-4', {
        envVarsOverride: { TERM: 'overridden' },
      })

      const env = spawnSpy.mock.calls[0][2].env as Record<string, string>
      expect(env.TERM).toBe('overridden')
    })

    it('does NOT allow ZDOTDIR override (sandbox anchor protection)', () => {
      const pty = require('node-pty')
      const spawnSpy = pty.spawn as jest.Mock
      spawnSpy.mockClear()

      session = new TerminalSession('test-env-5', {
        envVarsOverride: { ZDOTDIR: '/tmp/evil' },
      })

      const env = spawnSpy.mock.calls[0][2].env as Record<string, string>
      // ZDOTDIR は agent が sandbox の .zshrc を指すために設定する内部値。
      // envVarsOverride からの値は filter で弾かれ、agent が設定した tmpDir のまま。
      // (zsh shell でない場合は ZDOTDIR が設定されない or 上書き不可)
      expect(env.ZDOTDIR).not.toBe('/tmp/evil')
    })

    it('does NOT allow PATH or LD_PRELOAD override (defense in depth)', () => {
      const pty = require('node-pty')
      const spawnSpy = pty.spawn as jest.Mock
      spawnSpy.mockClear()

      session = new TerminalSession('test-env-6', {
        envVarsOverride: {
          PATH: '/tmp/evil:/usr/bin',
          LD_PRELOAD: '/tmp/evil.so',
          NODE_OPTIONS: '--inspect-brk=0.0.0.0:9229',
        },
      })

      const env = spawnSpy.mock.calls[0][2].env as Record<string, string>
      // PATH は safeEnv 由来の値が残るはず (envVarsOverride で上書きされない)
      expect(env.PATH).not.toBe('/tmp/evil:/usr/bin')
      expect(env.LD_PRELOAD).toBeUndefined()
      expect(env.NODE_OPTIONS).toBeUndefined()
    })

    describe('GIT_SSH_KEY_CONTENT_BASE64 SSH key setup', () => {
      it('GIT_SSH_KEY_CONTENT_BASE64 を検出したら GIT_SSH_COMMAND を設定する', () => {
        const pty = require('node-pty')
        const spawnSpy = pty.spawn as jest.Mock
        spawnSpy.mockClear()

        const pemKey = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key-content\n-----END OPENSSH PRIVATE KEY-----'
        const base64Key = Buffer.from(pemKey).toString('base64')

        session = new TerminalSession('test-ssh-1', {
          envVarsOverride: {
            GIT_SSH_KEY_CONTENT_BASE64: base64Key,
          },
        })

        const env = spawnSpy.mock.calls[0][2].env as Record<string, string>
        // GIT_SSH_COMMAND が設定されている
        expect(env.GIT_SSH_COMMAND).toMatch(/ssh -i .*ssh-key-test-ssh-1/)
        expect(env.GIT_SSH_COMMAND).toContain('-o StrictHostKeyChecking=no')
        // 元の変数は PTY には渡らない
        expect(env.GIT_SSH_KEY_CONTENT_BASE64).toBeUndefined()
      })

      it('SSH 鍵ファイルが実際に作成されている', () => {
        const pemKey = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-key-file-content\n-----END OPENSSH PRIVATE KEY-----'
        const base64Key = Buffer.from(pemKey).toString('base64')

        session = new TerminalSession('test-ssh-2', {
          envVarsOverride: {
            GIT_SSH_KEY_CONTENT_BASE64: base64Key,
          },
        })

        const expectedPath = path.join(os.tmpdir(), 'ssh-key-test-ssh-2')
        expect(fs.existsSync(expectedPath)).toBe(true)
        const content = fs.readFileSync(expectedPath, 'utf-8')
        expect(content).toBe(pemKey)
      })

      it('セッション終了時に SSH 鍵ファイルが削除される', (done) => {
        const pemKey = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-cleanup\n-----END OPENSSH PRIVATE KEY-----'
        const base64Key = Buffer.from(pemKey).toString('base64')

        session = new TerminalSession('test-ssh-3', {
          envVarsOverride: {
            GIT_SSH_KEY_CONTENT_BASE64: base64Key,
          },
        })

        const expectedPath = path.join(os.tmpdir(), 'ssh-key-test-ssh-3')
        expect(fs.existsSync(expectedPath)).toBe(true)

        session.onExit(() => {
          expect(fs.existsSync(expectedPath)).toBe(false)
          done()
        })
        session.kill()
      })

      it('GIT_SSH_KEY_CONTENT_BASE64 がない場合は GIT_SSH_COMMAND を設定しない', () => {
        const pty = require('node-pty')
        const spawnSpy = pty.spawn as jest.Mock
        spawnSpy.mockClear()

        session = new TerminalSession('test-ssh-4', {
          envVarsOverride: {
            ANTHROPIC_API_KEY: 'sk-test',
          },
        })

        const env = spawnSpy.mock.calls[0][2].env as Record<string, string>
        expect(env.GIT_SSH_COMMAND).toBeUndefined()
      })

      it('無効な base64 データでも安全にスキップする', () => {
        const pty = require('node-pty')
        const spawnSpy = pty.spawn as jest.Mock
        spawnSpy.mockClear()

        // 無効な base64（書き込みは成功するが、デコード後の内容は不正）
        // この場合でも crash せずにセッションが作成される
        session = new TerminalSession('test-ssh-5', {
          envVarsOverride: {
            GIT_SSH_KEY_CONTENT_BASE64: 'valid-base64-but-not-a-key',
          },
        })

        // セッションは正常に作成される
        expect(session.isAlive()).toBe(true)
      })
    })
  })
})

describe('TerminalSessionManager', () => {
  let manager: TerminalSessionManager

  beforeEach(() => {
    manager = new TerminalSessionManager()
  })

  afterEach(() => {
    manager.closeAll()
  })

  it('should create a session', () => {
    const session = manager.createSession()
    expect(session).not.toBeNull()
    expect(manager.size).toBe(1)
  })

  it('should create a session with default options (no args)', () => {
    const session = manager.createSession()
    expect(session).not.toBeNull()
    expect(manager.size).toBe(1)
  })

  it('should create a session with explicit id and default options', () => {
    const session = manager.createSessionWithId('custom-id')
    expect(session).not.toBeNull()
    expect(session!.sessionId).toBe('custom-id')
    expect(manager.size).toBe(1)
  })

  it('should list sessions', () => {
    manager.createSession()
    manager.createSession()
    const list = manager.listSessions()
    expect(list).toHaveLength(2)
    expect(list[0].sessionId).toBeTruthy()
  })

  it('should get session by id', () => {
    const session = manager.createSession()
    expect(session).not.toBeNull()
    const found = manager.getSession(session!.sessionId)
    expect(found).toBe(session)
  })

  it('should return undefined for unknown session', () => {
    expect(manager.getSession('nonexistent')).toBeUndefined()
  })

  it('should close a session', () => {
    const session = manager.createSession()
    expect(session).not.toBeNull()
    const result = manager.closeSession(session!.sessionId)
    expect(result).toBe(true)
    expect(manager.size).toBe(0)
  })

  it('should return false when closing unknown session', () => {
    expect(manager.closeSession('nonexistent')).toBe(false)
  })

  it('should enforce max concurrent sessions', () => {
    for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) {
      const s = manager.createSession()
      expect(s).not.toBeNull()
    }
    const extra = manager.createSession()
    expect(extra).toBeNull()
    expect(manager.size).toBe(MAX_CONCURRENT_SESSIONS)
  })

  it('should close all sessions', () => {
    manager.createSession()
    manager.createSession()
    expect(manager.size).toBe(2)
    manager.closeAll()
    expect(manager.size).toBe(0)
  })

  it('should remove session on idle timeout', (done) => {
    const origTimeout = constants.SESSION_IDLE_TIMEOUT_MS
    Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: 50, writable: true })

    const session = manager.createSession()
    expect(session).not.toBeNull()
    const sessionId = session!.sessionId

    const check = setInterval(() => {
      if (!manager.getSession(sessionId)) {
        clearInterval(check)
        Object.defineProperty(constants, 'SESSION_IDLE_TIMEOUT_MS', { value: origTimeout, writable: true })
        done()
      }
    }, 20)
  })

  it('should remove session from map on exit', (done) => {
    const session = manager.createSession()
    expect(session).not.toBeNull()
    const sessionId = session!.sessionId

    session!.write('exit\n')

    const check = setInterval(() => {
      if (!manager.getSession(sessionId)) {
        clearInterval(check)
        done()
      }
    }, 20)
  })
})

// cleanupStaleSandboxes の挙動を unit テストする。実ファイル操作は
// fs を spy する形ではなく、tmpdir に短命ディレクトリを作って検証する。
describe('TerminalSession.cleanupStaleSandboxes', () => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')

  function makeStaleDir(name: string, mtimeMs: number): string {
    const fullPath = path.join(os.tmpdir(), name)
    fs.mkdirSync(fullPath, { recursive: true })
    // mtime を過去にする
    const t = new Date(mtimeMs)
    fs.utimesSync(fullPath, t, t)
    return fullPath
  }

  afterEach(() => {
    // テストで作った残骸を掃除
    const tmp = os.tmpdir()
    for (const name of fs.readdirSync(tmp)) {
      if (name.startsWith('terminal-sandbox-jest-')) {
        try {
          fs.rmSync(path.join(tmp, name), { recursive: true, force: true })
        } catch { /* ignore */ }
      }
    }
  })

  it('24 時間以上古いものを削除する', () => {
    const oldPath = makeStaleDir(
      'terminal-sandbox-jest-old-' + Math.random().toString(36).slice(2),
      Date.now() - 25 * 60 * 60 * 1000,
    )
    expect(fs.existsSync(oldPath)).toBe(true)

    const removed = TerminalSession.cleanupStaleSandboxes()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(oldPath)).toBe(false)
  })

  it('新しいもの (24 時間以内) は残す', () => {
    const freshPath = makeStaleDir(
      'terminal-sandbox-jest-fresh-' + Math.random().toString(36).slice(2),
      Date.now() - 1000, // 1 秒前
    )

    TerminalSession.cleanupStaleSandboxes()
    expect(fs.existsSync(freshPath)).toBe(true)
  })

  it('maxAgeMs=0 で全削除する', () => {
    const freshPath = makeStaleDir(
      'terminal-sandbox-jest-all-' + Math.random().toString(36).slice(2),
      Date.now() - 1000,
    )

    const removed = TerminalSession.cleanupStaleSandboxes(0)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(freshPath)).toBe(false)
  })

  it('terminal-sandbox- プレフィックス以外には触れない', () => {
    const otherPath = path.join(os.tmpdir(), 'other-jest-' + Math.random().toString(36).slice(2))
    require('fs').mkdirSync(otherPath, { recursive: true })
    try {
      TerminalSession.cleanupStaleSandboxes(0)
      expect(fs.existsSync(otherPath)).toBe(true)
    } finally {
      try { fs.rmSync(otherPath, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  })
})
