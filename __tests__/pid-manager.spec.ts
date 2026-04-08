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

    it('should return pid when file exists', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '1234', 'utf-8')
      expect(readPidFile()).toBe(1234)
    })

    it('should return null for invalid content', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), 'invalid', 'utf-8')
      expect(readPidFile()).toBeNull()
    })

    it('should return null for zero', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '0', 'utf-8')
      expect(readPidFile()).toBeNull()
    })

    it('should return null for negative pid', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '-1', 'utf-8')
      expect(readPidFile()).toBeNull()
    })
  })

  describe('writePidFile / removePidFile', () => {
    it('should write current pid and remove it', () => {
      writePidFile()
      expect(readPidFile()).toBe(process.pid)
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
      // 非常に大きなPIDは存在しないはず
      expect(isProcessAlive(9999999)).toBe(false)
    })
  })

  describe('isAlreadyRunning', () => {
    it('should return false when pid file does not exist', () => {
      expect(isAlreadyRunning()).toBe(false)
    })

    it('should return true when pid is own process (process is alive)', () => {
      writePidFile()
      expect(isAlreadyRunning()).toBe(true)
    })

    it('should return true when another alive process pid is recorded', () => {
      // process.pid は生きているが、「別プロセス」のように見せるため
      // isProcessAlive をモックして true を返す別のPIDを設定
      jest.spyOn(process, 'kill').mockImplementation(() => true as never)
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '9999', 'utf-8')
      expect(isAlreadyRunning()).toBe(true)
    })

    it('should return false when pid 1 is recorded and current pid is not 1 (Docker stale pid)', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '1', 'utf-8')
      // 現在のプロセスはPID 1ではないはず（テスト環境）
      expect(process.pid).not.toBe(1)
      expect(isAlreadyRunning()).toBe(false)
    })

    it('should return false when recorded process is dead', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), '9999999', 'utf-8')
      expect(isAlreadyRunning()).toBe(false)
    })
  })
})
