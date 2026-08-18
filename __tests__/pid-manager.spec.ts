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

/**
 * 現在のプロセスの起動世代マーカー（プロセス開始時刻の epoch 秒）。
 * pid-manager の内部実装と同じ式をテスト側でも独立に計算する。
 */
function currentGeneration(): number {
  return Math.round(Date.now() / 1000 - process.uptime())
}

/**
 * 実装側の起動世代マーカーが厳密に `generation` になるよう時計を固定して fn を実行する。
 * 許容差の境界（±2秒）を検証する際、実測値の丸め誤差でテストが揺れるのを防ぐ。
 */
function withFrozenGeneration(generation: number, fn: () => void): void {
  const fixedNowMs = 1_700_000_000_000
  jest.spyOn(Date, 'now').mockReturnValue(fixedNowMs)
  jest.spyOn(process, 'uptime').mockReturnValue(fixedNowMs / 1000 - generation)
  try {
    fn()
  } finally {
    jest.restoreAllMocks()
  }
}

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

    it('should return PidEntry with generation for format "{hostname}:{pid}:{generation}"', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), 'myhost:1234:1700000000', 'utf-8')
      expect(readPidFile()).toEqual({ hostname: 'myhost', pid: 1234, generation: 1700000000 })
    })

    it('should return generation undefined for non-numeric generation', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), 'myhost:1234:abc', 'utf-8')
      const entry = readPidFile()
      expect(entry).toEqual({ hostname: 'myhost', pid: 1234 })
      expect(entry!.generation).toBeUndefined()
    })

    it('should return null for invalid pid even when generation is present', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), 'myhost:0:1700000000', 'utf-8')
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

    it('should write three fields "{hostname}:{pid}:{generation}"', () => {
      writePidFile()
      const raw = fs.readFileSync(path.join(tmpDir, 'agent.pid'), 'utf-8')
      const parts = raw.split(':')
      expect(parts).toHaveLength(3)
      expect(parts[0]).toBe(os.hostname())
      expect(parseInt(parts[1], 10)).toBe(process.pid)
      expect(Math.abs(parseInt(parts[2], 10) - currentGeneration())).toBeLessThanOrEqual(2)
    })

    it('should round-trip the generation through readPidFile', () => {
      writePidFile()
      const entry = readPidFile()
      expect(entry!.generation).toBeDefined()
      expect(Math.abs(entry!.generation! - currentGeneration())).toBeLessThanOrEqual(2)
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

    // 本命の回帰テスト: Kubernetes StatefulSet では hostname(Pod名) が再作成をまたいで
    // 不変で、かつエージェントは常に PID 1 で動くため、残存 PID ファイルが
    // 新しいプロセス自身を指してしまい永久に起動できなくなっていた。
    it('should return false when the entry points at our own pid but a different generation (k8s PID 1 case)', () => {
      const staleGeneration = currentGeneration() - 3600
      fs.writeFileSync(
        path.join(tmpDir, 'agent.pid'),
        `${os.hostname()}:${process.pid}:${staleGeneration}`,
        'utf-8',
      )
      expect(isAlreadyRunning()).toBe(false)
    })

    it('should return false when the entry points at our own pid without a generation (old format)', () => {
      fs.writeFileSync(path.join(tmpDir, 'agent.pid'), `${os.hostname()}:${process.pid}`, 'utf-8')
      expect(isAlreadyRunning()).toBe(false)
    })

    it('should return true when the entry points at our own pid with a matching generation', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'agent.pid'),
        `${os.hostname()}:${process.pid}:${currentGeneration()}`,
        'utf-8',
      )
      expect(isAlreadyRunning()).toBe(true)
    })

    it('should tolerate a generation skew of up to 2 seconds for our own pid', () => {
      const frozen = 1_700_000_000
      for (const skew of [-2, -1, 0, 1, 2]) {
        fs.writeFileSync(
          path.join(tmpDir, 'agent.pid'),
          `${os.hostname()}:${process.pid}:${frozen + skew}`,
          'utf-8',
        )
        withFrozenGeneration(frozen, () => {
          expect(isAlreadyRunning()).toBe(true)
        })
      }
    })

    it('should treat a generation skew beyond the tolerance as stale for our own pid', () => {
      const frozen = 1_700_000_000
      for (const skew of [-3, 3, 10]) {
        fs.writeFileSync(
          path.join(tmpDir, 'agent.pid'),
          `${os.hostname()}:${process.pid}:${frozen + skew}`,
          'utf-8',
        )
        withFrozenGeneration(frozen, () => {
          expect(isAlreadyRunning()).toBe(false)
        })
      }
    })

    // 実ホスト上の二重起動検知を弱めないこと: 別 pid は generation に関係なく生存確認で判定する
    it('should return true for another alive pid regardless of its generation', () => {
      jest.spyOn(process, 'kill').mockImplementation(() => undefined as never)
      fs.writeFileSync(
        path.join(tmpDir, 'agent.pid'),
        `${os.hostname()}:9999:${currentGeneration() - 3600}`,
        'utf-8',
      )
      expect(isAlreadyRunning()).toBe(true)
    })

    it('should return false for another dead pid even when its generation matches', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'agent.pid'),
        `${os.hostname()}:9999999:${currentGeneration()}`,
        'utf-8',
      )
      expect(isAlreadyRunning()).toBe(false)
    })
  })
})
