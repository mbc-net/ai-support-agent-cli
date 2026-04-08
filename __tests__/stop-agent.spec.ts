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
    const pid = readPidFile()
    expect(pid).toBe(process.pid)
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
    expect(readPidFile()).toBe(process.pid)
  })

  it('isProcessAlive should return true for current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('isProcessAlive should return false for non-existent pid', () => {
    // PID 999999999 is extremely unlikely to exist
    expect(isProcessAlive(999999999)).toBe(false)
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
    fs.writeFileSync(getPidFilePath(), String(targetPid), 'utf-8')

    await stopAgent()

    expect(fs.existsSync(getPidFilePath())).toBe(false)
    expect((logger.success as jest.Mock).mock.calls.length).toBeGreaterThan(0)
  })

  it('should log error when process.kill throws', async () => {
    // Write own pid so isProcessAlive returns true
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
    fs.writeFileSync(getPidFilePath(), String(process.pid), 'utf-8')

    // Mock isProcessAlive to return true, then mock process.kill via Object.defineProperty
    jest.spyOn(pidManager, 'isProcessAlive').mockReturnValueOnce(true)
    const originalKill = process.kill.bind(process)
    const killSpy = jest.fn().mockImplementationOnce(() => { throw 'EPERM string error' })
    Object.defineProperty(process, 'kill', { value: killSpy, configurable: true })
    try {
      await stopAgent()
    } finally {
      Object.defineProperty(process, 'kill', { value: originalKill, configurable: true })
      jest.restoreAllMocks()
    }

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
    fs.writeFileSync(getPidFilePath(), String(targetPid), 'utf-8')

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

    expect((logger.warn as jest.Mock).mock.calls.some(
      (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('timeout')
    )).toBe(true)
  })
})
