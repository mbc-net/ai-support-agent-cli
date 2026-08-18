import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TEST_DIR_NAME = '.ai-support-agent-stop-test-' + process.pid
const TEST_CONFIG_DIR = path.join(os.tmpdir(), TEST_DIR_NAME)

jest.mock('../src/constants', () => {
  const actual = jest.requireActual('../src/constants')
  return { ...actual, CONFIG_DIR: path.join(os.tmpdir(), '.ai-support-agent-stop-test-' + process.pid) }
})
jest.mock('os', () => {
  const originalOs = jest.requireActual('os')
  return { ...originalOs, homedir: () => require('os').tmpdir() }
})
jest.mock('../src/logger')

// pid-manager をスパイできるようにするためデフォルトimportを使う
import * as pidManager from '../src/pid-manager'
const { writePidFile, removePidFile, readPidFile, isProcessAlive, getPidFilePath } = pidManager
import { stopAgent } from '../src/commands/stop-agent'
import { logger } from '../src/logger'

/** pid-manager 内部と同じ式で現在の起動世代マーカーを計算する */
function currentGeneration(): number {
  return Math.round(Date.now() / 1000 - process.uptime())
}

/** 現在のホストが書いたことになる pidファイル内容を組み立てる */
function ownHostEntry(pid: number, generation: number = currentGeneration()): string {
  return `${os.hostname()}:${pid}:${generation}`
}

describe('pid-manager', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true })
    }
  })
  afterEach(() => {
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true })
    }
  })

  it('should write and read pid file', () => {
    writePidFile()
    const entry = readPidFile()
    expect(entry?.pid).toBe(process.pid)
  })

  it('should return null when pid file does not exist', () => {
    expect(readPidFile()).toBeNull()
  })

  it('should return null for invalid pid file content', () => {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(getPidFilePath(), 'not-a-number', 'utf-8')
    expect(readPidFile()).toBeNull()
  })

  it('should remove pid file', () => {
    writePidFile()
    expect(fs.existsSync(getPidFilePath())).toBe(true)
    removePidFile()
    expect(fs.existsSync(getPidFilePath())).toBe(false)
  })

  it('should not throw when removing non-existent pid file', () => {
    expect(() => removePidFile()).not.toThrow()
  })

  it('writePidFile should create directory if it does not exist', () => {
    // TEST_CONFIG_DIR は beforeEach で削除済み
    expect(fs.existsSync(TEST_CONFIG_DIR)).toBe(false)
    writePidFile()
    expect(fs.existsSync(getPidFilePath())).toBe(true)
  })

  it('writePidFile should succeed when directory already exists', () => {
    writePidFile()
    // 2回目の呼び出し: ディレクトリはすでに存在する（!existsSync が false のブランチ）
    writePidFile()
    expect(readPidFile()?.pid).toBe(process.pid)
  })

  it('isProcessAlive should return true for current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('isProcessAlive should return false for non-existent pid', () => {
    // PID 999999999 is extremely unlikely to exist
    expect(isProcessAlive(999999999)).toBe(false)
  })

  it('isAlreadyRunning should return false when no pid file exists', () => {
    expect(pidManager.isAlreadyRunning()).toBe(false)
  })

  it('isAlreadyRunning should return true when current process pid is written', () => {
    writePidFile()
    expect(pidManager.isAlreadyRunning()).toBe(true)
  })

  it('isAlreadyRunning should return false for stale pid file', () => {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(getPidFilePath(), '999999999', 'utf-8')
    expect(pidManager.isAlreadyRunning()).toBe(false)
  })
})

describe('stopAgent', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true })
    }
    jest.clearAllMocks()
  })
  afterEach(() => {
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true })
    }
  })

  it('should warn when no pid file exists', async () => {
    await stopAgent()
    expect((logger.warn as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('should clean up stale pid file when process is not alive', async () => {
    // Write a pid that does not exist
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(getPidFilePath(), '999999999', 'utf-8')

    await stopAgent()

    expect(fs.existsSync(getPidFilePath())).toBe(false)
    expect((logger.warn as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('should send SIGTERM and succeed when process exits promptly', async () => {
    // Spawn a child process to act as the "agent"
    const { spawn } = await import('child_process')
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    const targetPid = child.pid!

    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(getPidFilePath(), ownHostEntry(targetPid), 'utf-8')

    await stopAgent()

    expect(fs.existsSync(getPidFilePath())).toBe(false)
    expect((logger.success as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('should not signal a pid recorded by a different hostname', async () => {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    // 別ホスト（別コンテナ）が書いた記録。pid 番号は「このホストで生存している」
    // プロセス（自分自身）を指しているが、kill してはいけない。
    fs.writeFileSync(
      getPidFilePath(),
      `other-host:${process.pid}:${currentGeneration()}`,
      'utf-8',
    )

    const originalKill = process.kill.bind(process)
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const killSpy = jest.fn((pid: number, signal?: NodeJS.Signals | number) => {
      signals.push(signal)
      // 存在チェック(signal 0)だけは実行し、実シグナルは配送しない
      if (signal === 0) return originalKill(pid, 0)
      return true
    })
    Object.defineProperty(process, 'kill', { value: killSpy, configurable: true })
    try {
      await stopAgent()
    } finally {
      Object.defineProperty(process, 'kill', { value: originalKill, configurable: true })
    }

    expect(signals.filter((s) => s !== 0)).toHaveLength(0)
    expect((logger.warn as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('should not signal a pid recorded by a previous generation of our own process', async () => {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(getPidFilePath(), ownHostEntry(process.pid, currentGeneration() - 3600), 'utf-8')

    const originalKill = process.kill.bind(process)
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const killSpy = jest.fn((pid: number, signal?: NodeJS.Signals | number) => {
      signals.push(signal)
      if (signal === 0) return originalKill(pid, 0)
      return true
    })
    Object.defineProperty(process, 'kill', { value: killSpy, configurable: true })
    try {
      await stopAgent()
    } finally {
      Object.defineProperty(process, 'kill', { value: originalKill, configurable: true })
    }

    expect(signals.filter((s) => s !== 0)).toHaveLength(0)
    expect((logger.warn as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('should log error when process.kill throws', async () => {
    // The entry must point at a pid **other than our own** so that
    // isEntryRunning() actually reaches isProcessAlive(); an entry holding our
    // own pid short-circuits on the generation marker and never probes the
    // process at all. Spawn a real child so the liveness probe is genuine.
    const { spawn } = await import('child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    const targetPid = child.pid!

    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(getPidFilePath(), ownHostEntry(targetPid), 'utf-8')

    // Let the liveness probe (signal 0, issued from isProcessAlive) through so
    // the real code path runs, and make only the SIGTERM delivery throw.
    const originalKill = process.kill.bind(process)
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const killSpy = jest.fn((pid: number, signal?: NodeJS.Signals | number) => {
      signals.push(signal)
      if (signal === 0) return originalKill(pid, 0)
      throw 'EPERM string error'
    })
    Object.defineProperty(process, 'kill', { value: killSpy, configurable: true })
    try {
      await stopAgent()
    } finally {
      Object.defineProperty(process, 'kill', { value: originalKill, configurable: true })
      jest.restoreAllMocks()
      try { process.kill(targetPid, 'SIGKILL') } catch { /* ignore */ }
    }

    // Proof that the intended route was taken: the liveness probe ran against
    // the foreign pid, and SIGTERM was then attempted (and threw).
    expect(signals).toContain(0)
    expect(signals).toContain('SIGTERM')
    expect((logger.error as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('should warn on timeout when process does not exit', async () => {
    // Spawn a process that ignores SIGTERM
    const { spawn } = await import('child_process')
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 60000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    const targetPid = child.pid!

    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(getPidFilePath(), ownHostEntry(targetPid), 'utf-8')

    // Override WAIT_TIMEOUT_MS to 400ms via jest.useFakeTimers is complex,
    // so instead spy on isProcessAlive to always return true within this test
    jest.spyOn(pidManager, 'isProcessAlive').mockImplementation((pid) => {
      if (pid === targetPid) return true
      return false
    })

    // Reduce timeout by mocking Date.now to advance time quickly
    const realDateNow = Date.now
    let callCount = 0
    jest.spyOn(Date, 'now').mockImplementation(() => {
      callCount++
      // After 3 calls advance time past 10s timeout
      return callCount > 3 ? realDateNow() + 11_000 : realDateNow()
    })

    try {
      await stopAgent()
    } finally {
      jest.restoreAllMocks()
      // Clean up spawned child
      try { process.kill(targetPid, 'SIGKILL') } catch { /* ignore */ }
    }

    expect((logger.warn as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })
})
