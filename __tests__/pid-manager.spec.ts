import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// config-manager をモックして getConfigDir を制御
jest.mock('../src/config-manager', () => ({
  getConfigDir: jest.fn(),
}))

import { getConfigDir } from '../src/config-manager'
import {
  getPidFilePath,
  isAlreadyRunning,
  writePidFile,
  removePidFile,
  readPidFile,
  isProcessAlive,
} from '../src/pid-manager'

const mockGetConfigDir = getConfigDir as jest.MockedFunction<typeof getConfigDir>

describe('pid-manager', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-manager-test-'))
    mockGetConfigDir.mockReturnValue(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  describe('getPidFilePath', () => {
    it('should return path under configDir', () => {
      expect(getPidFilePath()).toBe(path.join(tmpDir, 'agent.pid'))
    })
  })

  describe('readPidFile', () => {
    it('should return null when file does not exist', () => {
      expect(readPidFile()).toBeNull()
    })

    it('should return PidEntry for new format "{hostname}:{pid}"', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), 'myhost:1234', 'utf-8')
      expect(readPidFile()).toEqual({ hostname: 'myhost', pid: 1234 })
    })

    it('should return PidEntry with empty hostname for legacy format (number only)', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '1234', 'utf-8')
      expect(readPidFile()).toEqual({ hostname: '', pid: 1234 })
    })

    it('should return null for invalid content', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), 'invalid', 'utf-8')
      expect(readPidFile()).toBeNull()
    })

    it('should return null for zero pid', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), 'host:0', 'utf-8')
      expect(readPidFile()).toBeNull()
    })

    it('should return null for negative pid', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), 'host:-1', 'utf-8')
      expect(readPidFile()).toBeNull()
    })

    it('should return null for legacy zero', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '0', 'utf-8')
      expect(readPidFile()).toBeNull()
    })

    it('should return null for legacy negative pid', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '-1', 'utf-8')
      expect(readPidFile()).toBeNull()
    })
  })

  describe('writePidFile / removePidFile', () => {
    it('should write current hostname and pid, then remove', () => {
      writePidFile()
      const entry = readPidFile()
      expect(entry).not.toBeNull()
      expect(entry!.pid).toBe(process.pid)
      expect(entry!.hostname).toBe(os.hostname())
      removePidFile()
      expect(readPidFile()).toBeNull()
    })

    it('should not throw when removing non-existent file', () => {
      expect(() => removePidFile()).not.toThrow()
    })
  })

  describe('isProcessAlive', () => {
    it('should return true for current process', () => {
      expect(isProcessAlive(process.pid)).toBe(true)
    })

    it('should return false for non-existent pid', () => {
      expect(isProcessAlive(9999999)).toBe(false)
    })
  })

  describe('isAlreadyRunning', () => {
    it('should return false when pid file does not exist', () => {
      expect(isAlreadyRunning()).toBe(false)
    })

    it('should return true when same hostname and pid is own process', () => {
      writePidFile()
      expect(isAlreadyRunning()).toBe(true)
    })

    it('should return true when same hostname and another alive process pid is recorded', () => {
      jest.spyOn(process, 'kill').mockImplementation(() => undefined as never)
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), `${os.hostname()}:9999`, 'utf-8')
      expect(isAlreadyRunning()).toBe(true)
    })

    it('should return true when EPERM is thrown (process exists but no permission)', () => {
      const epermError = Object.assign(new Error('EPERM'), { code: 'EPERM' })
      jest.spyOn(process, 'kill').mockImplementation(() => { throw epermError })
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), `${os.hostname()}:9999`, 'utf-8')
      expect(isAlreadyRunning()).toBe(true)
    })

    it('should return false when hostname differs (stale pid from another container)', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), 'other-container-id:1', 'utf-8')
      expect(isAlreadyRunning()).toBe(false)
    })

    it('should return false for legacy format (no hostname) — treated as stale', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '9999', 'utf-8')
      expect(isAlreadyRunning()).toBe(false)
    })

    it('should return false when recorded process is dead (same hostname)', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), `${os.hostname()}:9999999`, 'utf-8')
      expect(isAlreadyRunning()).toBe(false)
    })
  })
})
