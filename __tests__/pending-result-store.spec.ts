import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import axios from 'axios'
import {
  savePendingResult,
  removePendingResult,
  loadPendingResults,
  submitPendingResults,
  PENDING_RESULT_STALE_THRESHOLD_MS,
} from '../src/pending-result-store'
import { ApiClient } from '../src/api-client'

jest.mock('../src/api-client')
jest.mock('../src/logger')

const MockApiClient = ApiClient as jest.MockedClass<typeof ApiClient>

describe('pending-result-store', () => {
  let tempDir: string

  beforeEach(() => {
    jest.clearAllMocks()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-test-'))
    // Override CONFIG_DIR to use temp directory
    jest.spyOn(require('../src/config-manager'), 'getConfigDir').mockReturnValue(tempDir)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
    jest.restoreAllMocks()
  })

  const mockResult = { success: true as const, data: 'test output' }

  describe('savePendingResult', () => {
    it('should save a pending result file', () => {
      savePendingResult('cmd-1', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      const filePath = path.join(tempDir, 'pending-results', 'cmd-1.json')
      expect(fs.existsSync(filePath)).toBe(true)

      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      expect(content.commandId).toBe('cmd-1')
      expect(content.agentId).toBe('agent-1')
      expect(content.result).toEqual(mockResult)
      expect(content.apiUrl).toBe('http://api')
      expect(content.tenantCode).toBe('tenant-1')
      expect(content.savedAt).toBeDefined()
    })

    it('should create pending-results directory if it does not exist', () => {
      const pendingDir = path.join(tempDir, 'pending-results')
      expect(fs.existsSync(pendingDir)).toBe(false)

      savePendingResult('cmd-2', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      expect(fs.existsSync(pendingDir)).toBe(true)
    })

    it('should not throw if directory creation fails', () => {
      jest.spyOn(require('../src/config-manager'), 'getConfigDir').mockReturnValue('/nonexistent/path/that/will/fail')

      expect(() => {
        savePendingResult('cmd-3', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')
      }).not.toThrow()
    })
  })

  describe('removePendingResult', () => {
    it('should remove a pending result file', () => {
      savePendingResult('cmd-1', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      const filePath = path.join(tempDir, 'pending-results', 'cmd-1.json')
      expect(fs.existsSync(filePath)).toBe(true)

      removePendingResult('cmd-1')
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('should not throw for non-existent file', () => {
      expect(() => removePendingResult('nonexistent')).not.toThrow()
    })

    it('should swallow unlink failures (line 68 catch)', () => {
      // Make the target path a directory so unlinkSync throws a real fs error
      const pendingDir = path.join(tempDir, 'pending-results')
      fs.mkdirSync(path.join(pendingDir, 'cmd-dir.json'), { recursive: true })
      expect(() => removePendingResult('cmd-dir')).not.toThrow()
    })
  })

  describe('loadPendingResults', () => {
    it('should return empty array when no pending results', () => {
      expect(loadPendingResults()).toEqual([])
    })

    it('should load saved pending results', () => {
      savePendingResult('cmd-1', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')
      savePendingResult('cmd-2', 'agent-1', { success: false, error: 'fail' }, 'http://api', 'tok', 'tenant-1')

      const results = loadPendingResults()
      expect(results).toHaveLength(2)
      expect(results.map(r => r.commandId).sort()).toEqual(['cmd-1', 'cmd-2'])
    })

    it('should discard stale results (older than PENDING_RESULT_STALE_THRESHOLD_MS)', () => {
      // NOTE: the threshold was raised from 1 hour to 3 hours. At 1 hour the agent
      // deleted the result *before* the server gave up on the command
      // (MAX_COMMAND_EXECUTION_MS = 2 hours), which made a completed job
      // unrecoverable and reported it as TIMEOUT. See pending-result-retry.spec.ts.
      savePendingResult('cmd-stale', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      // Modify savedAt to be older than the threshold
      const filePath = path.join(tempDir, 'pending-results', 'cmd-stale.json')
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      content.savedAt = new Date(
        Date.now() - PENDING_RESULT_STALE_THRESHOLD_MS - 60 * 1000,
      ).toISOString()
      fs.writeFileSync(filePath, JSON.stringify(content))

      const results = loadPendingResults()
      expect(results).toHaveLength(0)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('should skip corrupted JSON files', () => {
      const pendingDir = path.join(tempDir, 'pending-results')
      fs.mkdirSync(pendingDir, { recursive: true })
      fs.writeFileSync(path.join(pendingDir, 'bad.json'), 'not json')

      savePendingResult('cmd-good', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      const results = loadPendingResults()
      expect(results).toHaveLength(1)
      expect(results[0].commandId).toBe('cmd-good')
    })

    it('should return empty array when directory does not exist', () => {
      fs.rmSync(tempDir, { recursive: true })
      expect(loadPendingResults()).toEqual([])
    })

    it('should swallow readdir failures and return empty (line 103 catch)', () => {
      // Make the pending-results path a file so readdirSync throws ENOTDIR
      fs.writeFileSync(path.join(tempDir, 'pending-results'), 'not a dir')
      expect(loadPendingResults()).toEqual([])
    })
  })

  describe('submitPendingResults', () => {
    it('should do nothing when no pending results', async () => {
      await submitPendingResults()
      expect(MockApiClient).not.toHaveBeenCalled()
    })

    it('should submit pending results and remove files on success', async () => {
      const mockSubmitResult = jest.fn().mockResolvedValue(undefined)
      const mockSetTenantCode = jest.fn()
      MockApiClient.mockImplementation(() => ({
        submitResult: mockSubmitResult,
        setTenantCode: mockSetTenantCode,
      }) as unknown as ApiClient)

      savePendingResult('cmd-1', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      await submitPendingResults()

      // 世代を持たない保存（この呼び出しでは未指定）は識別子ごと送らない。
      expect(MockApiClient).toHaveBeenCalledWith('http://api', 'tok', {
        withoutReplicaIdentity: true,
      })
      expect(mockSetTenantCode).toHaveBeenCalledWith('tenant-1')
      expect(mockSubmitResult).toHaveBeenCalledWith('cmd-1', mockResult, 'agent-1')

      // File should be removed after successful submission
      const filePath = path.join(tempDir, 'pending-results', 'cmd-1.json')
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('should keep file when submission fails with network error', async () => {
      MockApiClient.mockImplementation(() => ({
        submitResult: jest.fn().mockRejectedValue(new Error('network error')),
        setTenantCode: jest.fn(),
      }) as unknown as ApiClient)

      savePendingResult('cmd-1', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      await submitPendingResults()

      // File should still exist
      const filePath = path.join(tempDir, 'pending-results', 'cmd-1.json')
      expect(fs.existsSync(filePath)).toBe(true)
    })

    it('should discard file when server returns 4xx (command not found)', async () => {
      const axiosError = new axios.AxiosError('Not Found', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 404,
        data: { message: 'Command not found' },
      } as never)
      MockApiClient.mockImplementation(() => ({
        submitResult: jest.fn().mockRejectedValue(axiosError),
        setTenantCode: jest.fn(),
      }) as unknown as ApiClient)

      savePendingResult('cmd-1', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      await submitPendingResults()

      // File should be removed — no point retrying a non-existent command
      const filePath = path.join(tempDir, 'pending-results', 'cmd-1.json')
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('should discard file when server returns 410 Gone', async () => {
      const axiosError = new axios.AxiosError('Gone', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 410,
        data: {},
      } as never)
      MockApiClient.mockImplementation(() => ({
        submitResult: jest.fn().mockRejectedValue(axiosError),
        setTenantCode: jest.fn(),
      }) as unknown as ApiClient)

      savePendingResult('cmd-2', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      await submitPendingResults()

      const filePath = path.join(tempDir, 'pending-results', 'cmd-2.json')
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it.each([401, 403])('should keep file when server returns %d (auth issue)', async (status) => {
      const axiosError = new axios.AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
        status,
        data: {},
      } as never)
      MockApiClient.mockImplementation(() => ({
        submitResult: jest.fn().mockRejectedValue(axiosError),
        setTenantCode: jest.fn(),
      }) as unknown as ApiClient)

      savePendingResult('cmd-auth', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      await submitPendingResults()

      // File should be kept — auth issues may be resolved after re-login
      const filePath = path.join(tempDir, 'pending-results', 'cmd-auth.json')
      expect(fs.existsSync(filePath)).toBe(true)
    })
  })

  describe('再起動をまたいだ結果の再送', () => {
    const mockClient = (submitResult: jest.Mock) => {
      MockApiClient.mockImplementation(
        () =>
          ({ submitResult, setTenantCode: jest.fn() }) as unknown as ApiClient,
      )
    }

    it('指名世代も保存し、再送時に復元する（フェンシングを通すため）', async () => {
      // 世代を送らないとサーバーは「指名を名乗らない要求」として扱い、指名済み
      // コマンドへの書き込みを 409 で拒否する。その 409 は「別レプリカに奪われた」と
      // 解釈されて結果が破棄されるため、同一 Pod のクラッシュ→再起動という最も
      // 典型的なケースで実行済みの結果が失われる。
      const restoreAssignment = jest.fn()
      MockApiClient.mockImplementation(
        () =>
          ({
            submitResult: jest.fn().mockResolvedValue(undefined),
            setTenantCode: jest.fn(),
            restoreAssignment,
          }) as unknown as ApiClient,
      )

      savePendingResult(
        'cmd-1',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
        7,
      )
      const saved = JSON.parse(
        fs.readFileSync(
          path.join(tempDir, 'pending-results', 'cmd-1.json'),
          'utf-8',
        ),
      )
      expect(saved.assignmentGeneration).toBe(7)

      await submitPendingResults()

      expect(restoreAssignment).toHaveBeenCalledWith('cmd-1', 7)
    })

    it('世代を持たない旧形式のファイルでは復元を試みない', async () => {
      const restoreAssignment = jest.fn()
      MockApiClient.mockImplementation(
        () =>
          ({
            submitResult: jest.fn().mockResolvedValue(undefined),
            setTenantCode: jest.fn(),
            restoreAssignment,
          }) as unknown as ApiClient,
      )

      savePendingResult(
        'cmd-1',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )

      await submitPendingResults()

      expect(restoreAssignment).not.toHaveBeenCalled()
    })

    it('保存時の instanceId を再送に使う（Pod 再作成で ID が変わっても指名先と一致させる）', async () => {
      mockClient(jest.fn().mockResolvedValue(undefined))
      savePendingResult(
        'cmd-1',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
        3,
      )
      const saved = JSON.parse(
        fs.readFileSync(
          path.join(tempDir, 'pending-results', 'cmd-1.json'),
          'utf-8',
        ),
      )
      expect(typeof saved.instanceId).toBe('string')

      await submitPendingResults()

      expect(MockApiClient).toHaveBeenCalledWith('http://api', 'tok', {
        instanceId: saved.instanceId,
      })
    })

    it('instanceId を持たない旧形式のファイルはレプリカ識別子を送らない', async () => {
      // 旧バージョンが書いたファイルを現在の instanceId で送ると、サーバー側の
      // フェンシングで 409 になり実行済みの結果が捨てられる。
      mockClient(jest.fn().mockResolvedValue(undefined))
      const dir = path.join(tempDir, 'pending-results')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        path.join(dir, 'cmd-legacy.json'),
        JSON.stringify({
          commandId: 'cmd-legacy',
          agentId: 'agent-1',
          result: mockResult,
          apiUrl: 'http://api',
          token: 'tok',
          tenantCode: 'tenant-1',
          savedAt: new Date().toISOString(),
        }),
      )

      await submitPendingResults()

      expect(MockApiClient).toHaveBeenCalledWith('http://api', 'tok', {
        withoutReplicaIdentity: true,
      })
    })

    it('409（別レプリカが再実行済み）は理由が分かる警告を出して破棄する', async () => {
      const axiosError = new axios.AxiosError(
        'Conflict',
        'ERR_BAD_REQUEST',
        undefined,
        undefined,
        { status: 409, data: {} } as never,
      )
      mockClient(jest.fn().mockRejectedValue(axiosError))
      const { logger } = require('../src/logger')

      savePendingResult(
        'cmd-1',
        'agent-1',
        mockResult,
        'http://api',
        'tok',
        'tenant-1',
      )

      await submitPendingResults()

      expect(
        fs.existsSync(path.join(tempDir, 'pending-results', 'cmd-1.json')),
      ).toBe(false)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('re-claimed by another replica'),
      )
    })
  })
})
