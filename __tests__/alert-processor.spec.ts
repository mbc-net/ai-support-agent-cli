import axios from 'axios'

import { AlertProcessor, checkPendingAlerts } from '../src/alert-processor'
import { logger } from '../src/logger'

jest.mock('axios')
jest.mock('../src/logger')

const mockedAxios = axios as jest.Mocked<typeof axios>

const mockAlert = {
  alertNumber: 'AL000001',
  alarmName: 'CPUUtilizationHigh',
  state: 'ALARM' as const,
  reason: 'Threshold Crossed',
  timestamp: '2026-05-13T00:00:00Z',
  namespace: 'AWS/ECS',
  metricName: 'CPUUtilization',
  dimensions: [{ name: 'ServiceName', value: 'api' }],
  status: 'pending' as const,
  tenantCode: 'tenant1',
  projectCode: 'MBC_01',
}

function createMockClient() {
  return {
    getPendingAlerts: jest.fn().mockResolvedValue({ items: [mockAlert], total: 1 }),
    getStaleProcessingAlerts: jest.fn().mockResolvedValue({ items: [mockAlert], total: 1 }),
    getAlert: jest.fn().mockResolvedValue(mockAlert),
    updateAlertStatus: jest.fn().mockResolvedValue(undefined),
    findActiveIssueByAlarmName: jest.fn().mockResolvedValue(null),
    resolveIssueFromAlert: jest.fn().mockResolvedValue(undefined),
  }
}

describe('AlertProcessor', () => {
  let processor: AlertProcessor
  let mockClient: ReturnType<typeof createMockClient>

  beforeEach(() => {
    jest.clearAllMocks()
    mockClient = createMockClient()
    processor = new AlertProcessor(mockClient as never, 'tenant1', 'MBC_01')
  })

  describe('processAlert', () => {
    it('should skip when active issue already exists (duplicate check)', async () => {
      mockClient.findActiveIssueByAlarmName.mockResolvedValue({ id: 'EXISTING_ISSUE' })

      await processor.processAlert('AL000001')

      expect(mockClient.updateAlertStatus).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001',
        { status: 'processed', issueId: 'EXISTING_ISSUE' },
      )
    })

    it('should not auto-create an issue when no active issue exists (issue creation is workflow-owned)', async () => {
      // 課題自動作成の権限はアラームワークフロー（createIssue ノード）にあり、
      // エージェントが無条件に作成してはならない。ワークフローが createIssue を
      // 定義していない場合、未解決 Issue が無くても issueId なしで processed に留める。
      await processor.processAlert('AL000001')

      expect(mockedAxios.post).not.toHaveBeenCalled()
      expect(mockClient.updateAlertStatus).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001',
        { status: 'processed' },
      )
    })

    it('should revert to pending (not failed) when alert not found in RDS (sync delay)', async () => {
      // RDS 同期遅延は回復可能。failed にせず pending に戻して再試行に委ねる
      mockClient.getAlert.mockResolvedValue(null)

      await processor.processAlert('AL000001')

      // processing マーク後、pending に戻す（failed にはしない）
      expect(mockClient.updateAlertStatus).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001',
        { status: 'pending' },
      )
      expect(mockClient.updateAlertStatus).not.toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001',
        expect.objectContaining({ status: 'failed' }),
      )
    })

    it('should not throw when the pending-revert fails on alert-not-found path', async () => {
      mockClient.getAlert.mockResolvedValue(null)
      // First call (processing) succeeds; second call (pending revert) rejects
      mockClient.updateAlertStatus
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Network error'))

      await expect(processor.processAlert('AL000001')).resolves.not.toThrow()
    })

    it('should mark as failed and continue when error occurs', async () => {
      mockClient.updateAlertStatus
        .mockResolvedValueOnce(undefined) // processing
        .mockResolvedValueOnce(undefined) // failed

      mockClient.getAlert.mockRejectedValue(new Error('Network error'))

      await processor.processAlert('AL000001')

      expect(mockClient.updateAlertStatus).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001',
        expect.objectContaining({ status: 'failed', failureReason: 'Network error' }),
      )
    })

    it('should not throw when updateAlertStatus fails in outer catch block', async () => {
      mockClient.getAlert.mockRejectedValue(new Error('DB error'))
      // First call (processing) succeeds; second call in catch block rejects
      mockClient.updateAlertStatus
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Status update failed'))

      await expect(processor.processAlert('AL000001')).resolves.not.toThrow()
    })

    it('should NOT mark as failed when the initial processing update itself fails (leave for retry)', async () => {
      // step①（processing マーク）自体が失敗 → アラート未評価なので failed にしない
      mockClient.updateAlertStatus.mockRejectedValueOnce(new Error('transient network blip'))

      await expect(processor.processAlert('AL000001')).resolves.not.toThrow()

      // updateAlertStatus は processing の1回のみ。failed 更新は呼ばれない
      expect(mockClient.updateAlertStatus).toHaveBeenCalledTimes(1)
      expect(mockClient.updateAlertStatus).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001',
        { status: 'processing' },
      )
      // 評価系（getAlert）も呼ばれていない
      expect(mockClient.getAlert).not.toHaveBeenCalled()
    })

    it('should allow re-processing after the initial processing update failed (in-flight cleared)', async () => {
      // step① 失敗後、in-flight が解放され再試行できることを確認
      mockClient.updateAlertStatus.mockRejectedValueOnce(new Error('blip'))
      await processor.processAlert('AL000001')

      mockClient.updateAlertStatus.mockReset()
      mockClient.updateAlertStatus.mockResolvedValue(undefined)

      await processor.processAlert('AL000001')
      // 2回目は正常に評価が進む
      expect(mockClient.getAlert).toHaveBeenCalled()
    })

    it('should resolve existing issue when state is OK and active issue exists', async () => {
      const okAlert = { ...mockAlert, state: 'OK' as const }
      mockClient.getAlert.mockResolvedValue(okAlert)
      mockClient.findActiveIssueByAlarmName.mockResolvedValue({ id: 'JCCI_000071' })

      await processor.processAlert('AL000001')

      expect(mockClient.resolveIssueFromAlert).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001', 'JCCI_000071',
      )
      expect(mockClient.updateAlertStatus).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001',
        { status: 'processed', issueId: 'JCCI_000071' },
      )
    })

    it('should skip (processed) when state is OK and no active issue exists', async () => {
      const okAlert = { ...mockAlert, state: 'OK' as const }
      mockClient.getAlert.mockResolvedValue(okAlert)
      mockClient.findActiveIssueByAlarmName.mockResolvedValue(null)

      await processor.processAlert('AL000001')

      expect(mockClient.resolveIssueFromAlert).not.toHaveBeenCalled()
      expect(mockClient.updateAlertStatus).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001',
        { status: 'processed' },
      )
    })

    // ── 重複処理ガード（無限ループ防止） ───────────────────────────────────
    it('should skip duplicate processing of the same alert that is in flight', async () => {
      // getAlert を未解決の Promise にして処理を「飛行中」のまま保持する
      let resolveGetAlert!: (v: typeof mockAlert) => void
      mockClient.getAlert.mockReturnValue(
        new Promise((resolve) => { resolveGetAlert = resolve }),
      )

      // 1回目の処理を開始（await せず飛行中にする）
      const first = processor.processAlert('AL000001')
      // 2回目を同じ alertNumber で即座に呼ぶ → 重複ガードで早期 return
      await processor.processAlert('AL000001')

      // 2回目は updateAlertStatus('processing') を呼ばない（1回目の1回のみ）
      expect(mockClient.updateAlertStatus).toHaveBeenCalledTimes(1)

      // 1回目を完了させる
      resolveGetAlert(mockAlert)
      await first
    })

    it('should allow re-processing after the alert finishes (in-flight cleared)', async () => {
      await processor.processAlert('AL000001')
      mockClient.updateAlertStatus.mockClear()

      // 完了後は再処理可能（in-flight から削除済み）
      await processor.processAlert('AL000001')
      expect(mockClient.updateAlertStatus).toHaveBeenCalled()
    })

    it('should log error when failed-status update itself fails', async () => {
      mockClient.getAlert.mockRejectedValue(new Error('boom'))
      mockClient.updateAlertStatus
        .mockResolvedValueOnce(undefined) // processing
        .mockRejectedValueOnce(new Error('mark-failed error')) // failed 更新が失敗

      await expect(processor.processAlert('AL000001')).resolves.not.toThrow()

      // failed 更新の失敗は error ログに残す（握りつぶさない）
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to mark as'),
      )
    })
  })

  // ── スタック救済（別フロー） ─────────────────────────────────────────────
  describe('recoverStaleProcessingAlerts', () => {
    it('should call getStaleProcessingAlerts with the given threshold and process them', async () => {
      await processor.recoverStaleProcessingAlerts(30)

      expect(mockClient.getStaleProcessingAlerts).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 30,
      )
      // 取得したアラートを処理する（updateAlertStatus が呼ばれる）
      expect(mockClient.updateAlertStatus).toHaveBeenCalled()
    })

    it('should not throw when getStaleProcessingAlerts fails', async () => {
      mockClient.getStaleProcessingAlerts.mockRejectedValue(new Error('network'))
      await expect(processor.recoverStaleProcessingAlerts(30)).resolves.not.toThrow()
    })

    it('should do nothing when no stale alerts', async () => {
      mockClient.getStaleProcessingAlerts.mockResolvedValue({ items: [], total: 0 })
      await processor.recoverStaleProcessingAlerts(30)
      expect(mockClient.updateAlertStatus).not.toHaveBeenCalled()
    })
  })

  describe('checkPendingAlerts', () => {
    it('should process all pending alerts', async () => {
      await processor.checkPendingAlerts()

      expect(mockClient.getPendingAlerts).toHaveBeenCalledWith('tenant1', 'MBC_01')
      expect(mockClient.updateAlertStatus).toHaveBeenCalledWith(
        'tenant1', 'MBC_01', 'AL000001',
        { status: 'processed' },
      )
    })

    it('should not throw when getPendingAlerts fails', async () => {
      mockClient.getPendingAlerts.mockRejectedValue(new Error('Network error'))

      await expect(processor.checkPendingAlerts()).resolves.not.toThrow()
    })

    it('should do nothing when no pending alerts', async () => {
      mockClient.getPendingAlerts.mockResolvedValue({ items: [], total: 0 })

      await processor.checkPendingAlerts()

    })
  })
})

describe('checkPendingAlerts (standalone function)', () => {
  it('should create a processor and call checkPendingAlerts', async () => {
    const mockClient = createMockClient()
    mockClient.getPendingAlerts.mockResolvedValue({ items: [], total: 0 })

    await checkPendingAlerts(mockClient as never, 'tenant1', 'MBC_01')

    expect(mockClient.getPendingAlerts).toHaveBeenCalledWith('tenant1', 'MBC_01')
  })
})
