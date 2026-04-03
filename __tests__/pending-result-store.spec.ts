import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import axios from 'axios'
import {
  savePendingResult,
  removePendingResult,
  loadPendingResults,
  submitPendingResults,
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

    it('should discard stale results (older than 1 hour)', () => {
      savePendingResult('cmd-stale', 'agent-1', mockResult, 'http://api', 'tok', 'tenant-1')

      // Modify savedAt to be 2 hours ago
      const filePath = path.join(tempDir, 'pending-results', 'cmd-stale.json')
      const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      content.savedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
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

      expect(MockApiClient).toHaveBeenCalledWith('http://api', 'tok')
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
})
