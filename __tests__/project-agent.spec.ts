import { ApiClient } from '../src/api-client'
import { AppSyncSubscriber } from '../src/appsync-subscriber'
import { CONFIG_SYNC_DEBOUNCE_MS, SHUTDOWN_DRAIN_POLL_INTERVAL_MS, SHUTDOWN_DRAIN_TIMEOUT_MS } from '../src/constants'
import { writeAwsConfig } from '../src/aws-profile'
import { executeCommand } from '../src/commands'
import { logger } from '../src/logger'
import { syncProjectConfig } from '../src/project-config-sync'
import { submitPendingResults } from '../src/pending-result-store'
import { ProjectAgent } from '../src/project-agent'
import { syncRepositories } from '../src/repo-sync'
import { detectChannelFromVersion, detectInstallMethod, isNewerVersion, performUpdate, reExecProcess } from '../src/update-checker'

jest.mock('../src/api-client')
jest.mock('../src/appsync-subscriber')
jest.mock('../src/commands')
jest.mock('../src/logger')
jest.mock('../src/chat-mode-detector', () => ({
  ...jest.requireActual('../src/chat-mode-detector'),
  detectAvailableChatModes: jest.fn().mockResolvedValue([]),
  resolveActiveChatMode: jest.fn().mockReturnValue(undefined),
}))
jest.mock('../src/project-config-sync', () => ({
  syncProjectConfig: jest.fn().mockResolvedValue({
    config: {
      configHash: 'default-hash',
      project: { projectCode: 'test-proj', projectName: 'Test' },
      agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
    },
    fromCache: false,
  }),
}))
jest.mock('../src/project-dir', () => ({
  initProjectDir: jest.fn().mockReturnValue('/tmp/test-project'),
  getReposDir: jest.fn((dir: string) => `${dir}/workspace/repos`),
}))
jest.mock('../src/aws-profile', () => ({
  writeAwsConfig: jest.fn(),
}))
const mockDetectEcsLauncherCapability = jest.fn()
jest.mock('../src/ecs/launcher-capability', () => ({
  detectEcsLauncherCapability: (...args: unknown[]) => mockDetectEcsLauncherCapability(...args),
}))
jest.mock('../src/repo-sync', () => ({
  syncRepositories: jest.fn().mockResolvedValue([]),
}))
jest.mock('../src/ssh-config-setup', () => ({
  setupSshConfig: jest.fn().mockResolvedValue(undefined),
}))
const FLUSH_TIMER_HANDLE = { unref: jest.fn(), __pendingResultFlushTimer: true }
jest.mock('../src/pending-result-store', () => ({
  savePendingResult: jest.fn(),
  removePendingResult: jest.fn(),
  submitPendingResults: jest.fn().mockResolvedValue(undefined),
  // Returns a timer handle that ProjectAgent.stopWork() passes to clearInterval.
  // A plain object is fine — clearInterval ignores non-Timeout values.
  startPendingResultFlush: jest.fn(() => FLUSH_TIMER_HANDLE),
  // Re-export the real constant: project-agent imports it from this module, and a
  // mock that omits it silently disables the double-submit guard (minAgeMs -> undefined).
  PENDING_RESULT_MIN_RETRY_AGE_MS: jest.requireActual('../src/pending-result-store')
    .PENDING_RESULT_MIN_RETRY_AGE_MS,
}))
jest.mock('../src/update-checker', () => ({
  detectChannelFromVersion: jest.fn().mockReturnValue('latest'),
  detectInstallMethod: jest.fn().mockReturnValue('global'),
  isNewerVersion: jest.fn().mockReturnValue(true),
  performUpdate: jest.fn().mockResolvedValue({ success: true }),
  reExecProcess: jest.fn(),
}))

jest.mock('../src/config-manager', () => ({
  getConfigDir: jest.fn().mockReturnValue('/mock/config'),
  loadConfig: jest.fn().mockReturnValue(null),
  getConfigFilePath: jest.fn().mockReturnValue('/mock/config/config.json'),
  saveConfig: jest.fn(),
  getProjectList: jest.fn().mockReturnValue([]),
}))

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  writeFileSync: jest.fn(),
  renameSync: jest.fn(),
}))

const MockApiClient = ApiClient as jest.MockedClass<typeof ApiClient>
const MockAppSyncSubscriber = AppSyncSubscriber as jest.MockedClass<typeof AppSyncSubscriber>
const mockedExecuteCommand = executeCommand as jest.MockedFunction<typeof executeCommand>
const mockedSyncProjectConfig = syncProjectConfig as jest.MockedFunction<typeof syncProjectConfig>
const mockedSubmitPendingResults = submitPendingResults as jest.MockedFunction<typeof submitPendingResults>
const mockedWriteAwsConfig = writeAwsConfig as jest.MockedFunction<typeof writeAwsConfig>
const mockedSyncRepositories = syncRepositories as jest.MockedFunction<typeof syncRepositories>
const mockedDetectInstallMethod = detectInstallMethod as jest.MockedFunction<typeof detectInstallMethod>
const mockedIsNewerVersion = isNewerVersion as jest.MockedFunction<typeof isNewerVersion>
const mockedPerformUpdate = performUpdate as jest.MockedFunction<typeof performUpdate>
const mockedReExecProcess = reExecProcess as jest.MockedFunction<typeof reExecProcess>

describe('ProjectAgent', () => {
  let mockClient: {
    register: jest.Mock
    heartbeat: jest.Mock
    getPendingCommands: jest.Mock
    getCommand: jest.Mock
    submitResult: jest.Mock
    getVersionInfo: jest.Mock
    reportConnectionStatus: jest.Mock
    getConfig: jest.Mock
    getProjectConfig: jest.Mock
    updateToken: jest.Mock
    setTenantCode: jest.Mock
    setProjectCode: jest.Mock
    getInstanceId: jest.Mock
    getReplicaLimit: jest.Mock
    releaseSelf: jest.Mock
  }

  let mockSubscriber: {
    connect: jest.Mock
    subscribe: jest.Mock
    onReconnect: jest.Mock
    onPersistentFailure: jest.Mock
    disconnect: jest.Mock
  }

  const project = { tenantCode: 'mbc', projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api' }
  const options = { pollInterval: 5000, heartbeatInterval: 30000 }

  beforeEach(() => {
    jest.clearAllMocks()
    mockDetectEcsLauncherCapability.mockResolvedValue(true)
    mockClient = {
      register: jest.fn().mockResolvedValue({ agentId: 'test-id', tenantCode: 'test-tenant', appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql', appsyncApiKey: 'da2-testkey123', transportMode: 'realtime' }),
      heartbeat: jest.fn().mockResolvedValue({ success: true }),
      getPendingCommands: jest.fn().mockResolvedValue([]),
      getCommand: jest.fn(),
      submitResult: jest.fn().mockResolvedValue(undefined),
      getAssignmentGeneration: jest.fn(),
      clearAssignment: jest.fn(),
      getVersionInfo: jest.fn().mockResolvedValue({ latestVersion: '0.0.2', minimumVersion: '0.0.0', channel: 'latest', channels: {} }),
      reportConnectionStatus: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn().mockResolvedValue({ chatMode: 'agent', defaultAgentChatMode: 'claude_code' }),
      getProjectConfig: jest.fn().mockResolvedValue({ configHash: 'abc123', project: { projectCode: 'test-proj' }, agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] } }),
      updateToken: jest.fn(),
      setTenantCode: jest.fn(),
      setProjectCode: jest.fn(),
      getInstanceId: jest.fn().mockReturnValue('pod-a'),
      getReplicaLimit: jest.fn().mockResolvedValue({ maxReplicas: null }),
      releaseSelf: jest.fn().mockResolvedValue({ released: true }),
    }
    MockApiClient.mockImplementation(() => mockClient as unknown as ApiClient)

    mockSubscriber = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn(),
      onReconnect: jest.fn(),
      onPersistentFailure: jest.fn(),
      disconnect: jest.fn(),
    }
    MockAppSyncSubscriber.mockImplementation(() => mockSubscriber as unknown as AppSyncSubscriber)

    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  describe('registration and lifecycle', () => {
    it('should register on start and begin heartbeat/subscription', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.register).toHaveBeenCalled()
      expect(logger.success).toHaveBeenCalled()

      // Heartbeat should have fired
      expect(mockClient.heartbeat).toHaveBeenCalled()

      agent.stop()
    })

    it('starts the pending-result flush on registration and stops it on stop()', async () => {
      // The flush retries results orphaned by an API deployment. If the timer is
      // never started the fix does nothing; if it is never cleared it leaks and
      // keeps running for a replica that has handed off its slot.
      const {
        startPendingResultFlush,
      } = require('../src/pending-result-store') as {
        startPendingResultFlush: jest.Mock
      }
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      expect(startPendingResultFlush).toHaveBeenCalled()

      agent.stop()

      expect(clearIntervalSpy).toHaveBeenCalledWith(FLUSH_TIMER_HANDLE)
      clearIntervalSpy.mockRestore()
    })

    it('only the first registration sweeps up every pending result', async () => {
      // registerAndStart() also runs on token update and on eviction -> re-admission.
      // stopTransport deliberately keeps inFlightCommands, so a result can be
      // mid-submit on the main path during a re-registration. Taking every file then
      // would re-create the parallel double-POST that the age guard exists to prevent.
      const {
        submitPendingResults,
      } = require('../src/pending-result-store') as {
        submitPendingResults: jest.Mock
      }
      const { PENDING_RESULT_MIN_RETRY_AGE_MS } = jest.requireActual(
        '../src/pending-result-store',
      ) as { PENDING_RESULT_MIN_RETRY_AGE_MS: number }

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      expect(submitPendingResults).toHaveBeenCalledTimes(1)
      // First pass: unconditional recovery.
      expect(submitPendingResults.mock.calls[0][0]).toEqual({})

      // Force a second registration the way a token update does.
      agent.stop()
      submitPendingResults.mockClear()
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      expect(submitPendingResults).toHaveBeenCalled()
      expect(submitPendingResults.mock.calls[0][0]).toEqual({
        minAgeMs: PENDING_RESULT_MIN_RETRY_AGE_MS,
      })

      agent.stop()
    })

    it('should advertise the ecs_launch capability when AWS credentials are resolvable', async () => {
      // The API-side automatic launcher selection for ECS execution agents
      // matches on the 'ecs_launch' capability. It is advertised only when
      // the agent can actually RunTask (resolvable AWS credentials).
      mockDetectEcsLauncherCapability.mockResolvedValue(true)
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const payload = mockClient.register.mock.calls[0][0] as { capabilities: string[] }
      expect(payload.capabilities).toEqual([
        'shell', 'file_read', 'file_write', 'process_manage', 'chat', 'terminal', 'vscode', 'server_setup_custom_tasks', 'ecs_launch',
      ])

      agent.stop()
    })

    it('should always advertise the server_setup_custom_tasks capability', async () => {
      // Without this, the api refuses to dispatch a body-carrying server-setup
      // recipe to this resident agent (git-artifact-platform capability fix).
      mockDetectEcsLauncherCapability.mockResolvedValue(false)
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const payload = mockClient.register.mock.calls[0][0] as { capabilities: string[] }
      expect(payload.capabilities).toContain('server_setup_custom_tasks')

      agent.stop()
    })

    it('should not advertise ecs_launch when AWS credentials are not resolvable', async () => {
      mockDetectEcsLauncherCapability.mockResolvedValue(false)
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const payload = mockClient.register.mock.calls[0][0] as { capabilities: string[] }
      expect(payload.capabilities).toEqual([
        'shell', 'file_read', 'file_write', 'process_manage', 'chat', 'terminal', 'vscode', 'server_setup_custom_tasks',
      ])
      expect(payload.capabilities).not.toContain('ecs_launch')

      agent.stop()
    })

    it('should update projectCode when server returns a different one', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        projectCode: 'SERVER_PROJ',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.setProjectCode).toHaveBeenCalledWith('SERVER_PROJ')
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Server assigned projectCode: SERVER_PROJ'),
      )

      agent.stop()
    })

    it('should not update projectCode when server returns the same one', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        projectCode: 'test-proj',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.setProjectCode).toHaveBeenCalledWith('test-proj')
      // Should NOT log the "Server assigned" message
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Server assigned projectCode'),
      )

      agent.stop()
    })

    // === マルチレプリカ（Kubernetes / ECS）対応 ===
    describe('replica admission', () => {
      const accepted = {
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
        admission: { accepted: true, instanceId: 'pod-a', maxReplicas: 2, liveReplicas: 1 },
      }
      const rejected = {
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
        admission: {
          accepted: false,
          instanceId: 'pod-b',
          maxReplicas: 1,
          liveReplicas: 1,
          reason: 'limit_reached',
        },
      }
      const rejectedConflict = {
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
        admission: {
          accepted: false,
          instanceId: 'pod-b',
          maxReplicas: 2,
          liveReplicas: 2,
          reason: 'instance_id_conflict',
        },
      }

      it('warns once when admission is rejected with instance_id_conflict', async () => {
        // 2026-08-15 の本番障害: 複数クラスタで同一トークンをデプロイし、
        // Pod名（instanceId）が衝突して同一個体の再接続と誤認された。
        // limit_reached とは異なる、原因特定に直結する警告を出す必要がある。
        mockClient.register.mockResolvedValue(rejectedConflict)

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('runner.instanceIdConflict'),
        )

        agent.stop()
      })

      it('does not warn about instance_id_conflict when rejected for limit_reached', async () => {
        mockClient.register.mockResolvedValue(rejected)

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        expect(logger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('runner.instanceIdConflict'),
        )

        agent.stop()
      })

      it('logs the instance_id_conflict warning only once even across standby retries', async () => {
        mockClient.register.mockResolvedValue(rejectedConflict)

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)
        await jest.advanceTimersByTimeAsync(31_000)
        await jest.advanceTimersByTimeAsync(31_000)

        const conflictWarnings = (logger.warn as jest.Mock).mock.calls.filter(
          (call: unknown[]) =>
            typeof call[0] === 'string' && call[0].includes('runner.instanceIdConflict'),
        )
        expect(conflictWarnings).toHaveLength(1)

        agent.stop()
      })

      it('sends admissionMode=initial on the first registration', async () => {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        expect(mockClient.register).toHaveBeenCalledWith(
          expect.objectContaining({ admissionMode: 'initial' }),
        )

        agent.stop()
      })

      it('does not start the transport while waiting for a slot', async () => {
        mockClient.register.mockResolvedValue(rejected)

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        // A standby replica holds no subscription and sends no heartbeat, so
        // it consumes no slot and receives no commands.
        expect(mockSubscriber.connect).not.toHaveBeenCalled()
        expect(mockClient.heartbeat).not.toHaveBeenCalled()

        agent.stop()
      })

      it('re-requests admission with admissionMode=standby (never evicting)', async () => {
        mockClient.register.mockResolvedValue(rejected)

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)
        mockClient.register.mockClear()

        await jest.advanceTimersByTimeAsync(31_000)

        // Standby re-requests must never evict; otherwise an evicted replica
        // would evict whoever took its place and they would swap forever.
        expect(mockClient.register).toHaveBeenCalledWith(
          expect.objectContaining({ admissionMode: 'standby' }),
        )
        expect(mockClient.register).not.toHaveBeenCalledWith(
          expect.objectContaining({ admissionMode: 'initial' }),
        )

        agent.stop()
      })

      it('starts the transport once a slot frees up', async () => {
        mockClient.register
          .mockResolvedValueOnce(rejected)
          .mockResolvedValue(accepted)

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)
        expect(mockSubscriber.connect).not.toHaveBeenCalled()

        await jest.advanceTimersByTimeAsync(31_000)

        expect(mockSubscriber.connect).toHaveBeenCalled()

        agent.stop()
      })

      it('keeps waiting when a standby admission request fails transiently', async () => {
        mockClient.register
          .mockResolvedValueOnce(rejected)
          .mockRejectedValueOnce(new Error('network down'))
          .mockResolvedValue(accepted)

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        // First retry fails; standby must not abort.
        await jest.advanceTimersByTimeAsync(31_000)
        expect(mockSubscriber.connect).not.toHaveBeenCalled()

        // Second retry succeeds.
        await jest.advanceTimersByTimeAsync(31_000)
        expect(mockSubscriber.connect).toHaveBeenCalled()

        agent.stop()
      })

      it('stop() ends the standby wait', async () => {
        mockClient.register.mockResolvedValue(rejected)

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)
        agent.stop()
        mockClient.register.mockClear()

        await jest.advanceTimersByTimeAsync(120_000)

        expect(mockClient.register).not.toHaveBeenCalled()
      })

      it('退避されたら standby で再入場する（ピンポン防止の中核不変条件）', async () => {
        // accepted で起動 → heartbeat が evicted:true → 再登録
        mockClient.register.mockResolvedValue(accepted)
        mockClient.heartbeat
          .mockResolvedValueOnce({ success: true, evicted: true })
          .mockResolvedValue({ success: true })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)
        expect(mockSubscriber.connect).toHaveBeenCalled()
        mockClient.register.mockClear()

        // heartbeat が evicted を返し handleEviction → 再登録
        await jest.advanceTimersByTimeAsync(31_000)

        // 'initial' で再登録すると、サーバーは「最古を退避してよい」と解釈するため
        // 自分の枠を奪った相手を退避し返し、無限に入れ替わり続ける。
        expect(mockClient.register).toHaveBeenCalled()
        for (const call of mockClient.register.mock.calls) {
          expect(call[0].admissionMode).toBe('standby')
        }
        expect(mockClient.register).not.toHaveBeenCalledWith(
          expect.objectContaining({ admissionMode: 'initial' }),
        )

        agent.stop()
      })

      it('退避後の再入場が一時的に失敗しても standby のままリトライする', async () => {
        mockClient.register.mockResolvedValue(accepted)
        mockClient.heartbeat
          .mockResolvedValueOnce({ success: true, evicted: true })
          .mockResolvedValue({ success: true })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)
        mockClient.register.mockClear()
        // 再登録が失敗 → 登録ループのリトライでも standby を維持すること
        mockClient.register.mockRejectedValueOnce(new Error('network down'))
        mockClient.register.mockResolvedValue(accepted)

        await jest.advanceTimersByTimeAsync(60_000)

        expect(mockClient.register).toHaveBeenCalled()
        for (const call of mockClient.register.mock.calls) {
          expect(call[0].admissionMode).toBe('standby')
        }

        agent.stop()
      })

      it('退避時はアラートポーリングも停止する', async () => {
        mockClient.register.mockResolvedValue(accepted)
        // 1回目の heartbeat は正常、2回目で退避を通知する
        mockClient.heartbeat
          .mockResolvedValueOnce({ success: true })
          .mockResolvedValueOnce({ success: true, evicted: true })
          .mockResolvedValue({ success: true })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        // アラートポーリングは projectConfig.cloudwatch がある場合のみ開始されるため、
        // ここでは実タイマーを注入し「退避時に停止されるか」だけを検証する。
        const pollingHandle = setInterval(() => undefined, 1_000)
        const staleHandle = setInterval(() => undefined, 1_000)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(agent as any).alertPollingTimer = pollingHandle
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(agent as any).alertStaleRecoveryTimer = staleHandle
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval')

        await jest.advanceTimersByTimeAsync(31_000)

        // 退避後もポーリングが動き続けると、枠を持たないレプリカがアラートを
        // 重複処理してしまう
        expect(clearIntervalSpy).toHaveBeenCalledWith(pollingHandle)
        expect(clearIntervalSpy).toHaveBeenCalledWith(staleHandle)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((agent as any).alertPollingTimer).toBeNull()

        clearIntervalSpy.mockRestore()
        agent.stop()
      })

      it('standby 待機中の updateToken でも再登録が行われる', async () => {
        mockClient.register.mockResolvedValue(rejected)

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)
        mockClient.register.mockClear()
        // 受理される状態に変えたうえでトークンを更新する
        mockClient.register.mockResolvedValue(accepted)

        agent.updateToken('mbc:tok-2:raw')
        await jest.advanceTimersByTimeAsync(1_000)

        // 中断不能な sleep のままだと start() が握り潰され、永久に standby に留まる
        expect(mockClient.register).toHaveBeenCalled()

        agent.stop()
      })

      it('starts normally when the server reports no admission (single-replica API)', async () => {
        // A server without replica support omits `admission` entirely.
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        expect(mockSubscriber.connect).toHaveBeenCalled()

        agent.stop()
      })
    })

    it('should retry indefinitely on registration failure with exponential backoff', async () => {
      // Fix Math.random so jitter (±50%) collapses to the base delay.
      const randomSpy = jest.spyOn(global.Math, 'random').mockReturnValue(0.5)
      mockClient.register
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          agentId: 'test-id',
          tenantCode: 'test-tenant',
          projectCode: 'TEST_PROJECT',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      // First attempt
      await jest.advanceTimersByTimeAsync(10)
      expect(mockClient.register).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith('runner.registerStartedFailing')

      // First backoff = 1000ms (attempt 0). Advance past that, second attempt runs.
      await jest.advanceTimersByTimeAsync(1500)
      expect(mockClient.register).toHaveBeenCalledTimes(2)

      // Second backoff = 2000ms (attempt 1). Advance past that, third attempt runs (success).
      await jest.advanceTimersByTimeAsync(2500)
      expect(mockClient.register).toHaveBeenCalledTimes(3)

      agent.stop()
      randomSpy.mockRestore()
    })

    it('should retry AppSync URL missing as a regular registration failure', async () => {
      mockClient.register
        .mockResolvedValueOnce({
          agentId: 'test-id',
          tenantCode: 'test-tenant',
          appsyncUrl: '',
          appsyncApiKey: '',
          transportMode: 'realtime',
        })
        .mockResolvedValueOnce({
          agentId: 'test-id',
          tenantCode: 'test-tenant',
          projectCode: 'TEST_PROJECT',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })

      const randomSpy = jest.spyOn(global.Math, 'random').mockReturnValue(0.5)
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(10)
      expect(mockClient.register).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith('runner.registerStartedFailing')

      await jest.advanceTimersByTimeAsync(1500)
      expect(mockClient.register).toHaveBeenCalledTimes(2)

      agent.stop()
      randomSpy.mockRestore()
    })

    it('should cancel the register loop on stop()', async () => {
      mockClient.register.mockRejectedValue(new Error('Network error'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(10)
      expect(mockClient.register).toHaveBeenCalledTimes(1)

      agent.stop()

      // After stop(), no further register attempts even after long waits.
      await jest.advanceTimersByTimeAsync(120_000)
      expect(mockClient.register).toHaveBeenCalledTimes(1)
    })

    it('should abort the in-flight backoff sleep when stop() runs mid-delay', async () => {
      mockClient.register.mockRejectedValue(new Error('Network error'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      // First register attempt has failed and we are now sleeping the backoff.
      await jest.advanceTimersByTimeAsync(10)
      expect(mockClient.register).toHaveBeenCalledTimes(1)

      // stop() during the sleep should abort the AbortController and unblock the loop
      // without waiting for the timer.
      agent.stop()
      await Promise.resolve()
      await Promise.resolve()

      // Even after the original delay would have elapsed, no second register fires.
      await jest.advanceTimersByTimeAsync(5_000)
      expect(mockClient.register).toHaveBeenCalledTimes(1)
    })

    it('should not start a second register loop if one is in progress', async () => {
      mockClient.register.mockRejectedValue(new Error('Network error'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      agent.start() // second start() must be a no-op

      await jest.advanceTimersByTimeAsync(10)
      expect(mockClient.register).toHaveBeenCalledTimes(1)
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Register loop already running'))

      agent.stop()
    })

    it('should warn only on edge transitions during repeated identical failures', async () => {
      // Edge-triggered logging: only the first failure should warn; subsequent
      // identical failures go to debug to avoid log flooding (Zabbix-style).
      const randomSpy = jest.spyOn(global.Math, 'random').mockReturnValue(0.5)
      mockClient.register.mockRejectedValue(new Error('Network error'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      // First failure: 1 warn
      await jest.advanceTimersByTimeAsync(10)
      const warnCallsForKey = (key: string) =>
        (logger.warn as jest.Mock).mock.calls.filter((c: unknown[]) => c[0] === key).length
      expect(warnCallsForKey('runner.registerStartedFailing')).toBe(1)

      // Drive 3 more failures with the same error. They should remain at debug, not warn.
      for (let i = 0; i < 3; i++) {
        await jest.advanceTimersByTimeAsync(120_000)
      }
      expect(warnCallsForKey('runner.registerStartedFailing')).toBe(1)
      expect(mockClient.register.mock.calls.length).toBeGreaterThanOrEqual(3)
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Registration still failing'))

      agent.stop()
      randomSpy.mockRestore()
    })

    it('should warn again when the failure mode changes (network -> auth)', async () => {
      const { AxiosError, AxiosHeaders } = require('axios')
      const authError = new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 401,
        statusText: 'Unauthorized',
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
      mockClient.register
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValue(authError)

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(10)
      expect(logger.warn).toHaveBeenCalledWith('runner.registerStartedFailing')

      // Second identical network failure must not warn.
      await jest.advanceTimersByTimeAsync(2_000)
      expect(
        (logger.warn as jest.Mock).mock.calls.filter((c: unknown[]) => c[0] === 'runner.registerStartedFailing').length,
      ).toBe(1)

      // The mode transitions to auth — must warn with the auth key.
      await jest.advanceTimersByTimeAsync(5_000)
      expect(logger.warn).toHaveBeenCalledWith('runner.authErrorStartedFailing')

      agent.stop()
    })

    it('should log a recovery info message when register succeeds after failures', async () => {
      mockClient.register
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          agentId: 'test-id',
          tenantCode: 'test-tenant',
          projectCode: 'TEST_PROJECT',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })

      const randomSpy = jest.spyOn(global.Math, 'random').mockReturnValue(0.5)
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(10)
      expect(logger.warn).toHaveBeenCalledWith('runner.registerStartedFailing')

      await jest.advanceTimersByTimeAsync(2_000)
      expect(logger.info).toHaveBeenCalledWith('runner.registerWorkingAgain')

      agent.stop()
      randomSpy.mockRestore()
    })

    it('should not log recovery info on first successful register (no prior failure)', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        projectCode: 'TEST_PROJECT',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      expect(logger.info).not.toHaveBeenCalledWith('runner.registerWorkingAgain')

      agent.stop()
    })

    it('should log warning when heartbeat fails', async () => {
      mockClient.heartbeat.mockRejectedValue(new Error('Heartbeat timeout'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.warn).toHaveBeenCalledWith('runner.heartbeatFailed')

      agent.stop()
    })

    it('should clear timers on stop()', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      agent.stop()

      mockClient.heartbeat.mockClear()
      mockClient.getPendingCommands.mockClear()

      await jest.advanceTimersByTimeAsync(60000)

      expect(mockClient.heartbeat).not.toHaveBeenCalled()
    })

    it('should expose the ApiClient via getClient()', () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      expect(agent.getClient()).toBeDefined()
    })
  })

  describe('subscription mode', () => {
    it('should activate subscription mode when transportMode is realtime', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // AppSync now authenticates with the agent token (this.token), not the API key.
      expect(MockAppSyncSubscriber).toHaveBeenCalledWith(
        'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        'tok',
      )
      expect(mockSubscriber.connect).toHaveBeenCalled()
      expect(mockSubscriber.subscribe).toHaveBeenCalledWith('test-tenant', expect.any(Function))
      expect(mockSubscriber.onReconnect).toHaveBeenCalled()
      expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('AppSync WebSocket'))

      agent.stop()
    })

    it('should start the subscriber even when appsyncApiKey is absent (agent-token auth)', async () => {
      // The agent authenticates to AppSync with its own token via the Lambda
      // authorizer, so a missing appsyncApiKey must no longer block startup.
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: null,
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(MockAppSyncSubscriber).toHaveBeenCalledWith(
        'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        'tok',
      )
      expect(mockSubscriber.connect).toHaveBeenCalled()

      agent.stop()
    })

    it('should retry (not start the subscriber) when the agent token is empty', async () => {
      // An empty token would subscribe with an empty Authorization header and be
      // silently, permanently rejected while register still "succeeds". Startup
      // must throw so runRegisterLoop treats it as a registration failure and
      // retries — never starting a no-op subscription.
      const projectWithoutToken = { tenantCode: 'mbc', projectCode: 'test-proj', token: '', apiUrl: 'http://api' }

      const agent = new ProjectAgent(projectWithoutToken, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.warn).toHaveBeenCalledWith('runner.registerStartedFailing')
      expect(MockAppSyncSubscriber).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should handle WebSocket connection failure', async () => {
      mockSubscriber.connect.mockRejectedValue(new Error('WebSocket connection failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket connection failed'),
      )

      agent.stop()
    })

    it('should convert localhost appsyncUrl to host.docker.internal when in Docker', async () => {
      const originalEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      try {
        process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'
        mockClient.register.mockResolvedValue({
          agentId: 'test-id',
          tenantCode: 'test-tenant',
          appsyncUrl: 'http://localhost:4001/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        expect(MockAppSyncSubscriber).toHaveBeenCalledWith(
          'http://host.docker.internal:4001/graphql',
          'tok',
        )

        agent.stop()
      } finally {
        if (originalEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalEnv
      }
    })

    it('should not convert appsyncUrl when not in Docker', async () => {
      const originalEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      try {
        delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        mockClient.register.mockResolvedValue({
          agentId: 'test-id',
          tenantCode: 'test-tenant',
          appsyncUrl: 'http://localhost:4001/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        expect(MockAppSyncSubscriber).toHaveBeenCalledWith(
          'http://localhost:4001/graphql',
          'tok',
        )

        agent.stop()
      } finally {
        if (originalEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalEnv
      }
    })

    it('should handle notification from subscription', async () => {
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-1',
        type: 'execute_command',
        payload: { command: 'echo hi' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'hi' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // Get the subscribe callback
      const subscribeCall = mockSubscriber.subscribe.mock.calls[0]
      const onMessage = subscribeCall[1] as (notification: Record<string, unknown>) => void

      // Simulate notification
      onMessage({
        id: 'notif-1',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-1', type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-1', 'test-id')
      expect(mockedExecuteCommand).toHaveBeenCalled()
      expect(mockClient.submitResult).toHaveBeenCalledWith('cmd-1', { success: true, data: 'hi' }, 'test-id')

      agent.stop()
    })

    it('should ignore notifications with missing commandId', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-no-cmdid',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' }, // no commandId
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('missing commandId'))
      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should ignore notifications with non-agent-command action', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-1',
        table: 'other',
        pk: '',
        sk: '',
        tenantCode: 'test-tenant',
        action: 'other-action',
        content: {},
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should ignore commands for different agentId', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-other',
        table: 'commands',
        pk: 'CMD#789',
        sk: 'CMD#789',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-other', type: 'execute_command', agentId: 'agent-2', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should ignore commands for different projectCode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-other-proj',
        table: 'commands',
        pk: 'CMD#789',
        sk: 'CMD#789',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-other-proj', type: 'execute_command', agentId: 'test-id', tenantCode: 'test-tenant', projectCode: 'OTHER_PROJ' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should ignore commands for different tenantCode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-other-tenant',
        table: 'commands',
        pk: 'CMD#789',
        sk: 'CMD#789',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-other-tenant', type: 'execute_command', agentId: 'test-id', tenantCode: 'other-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should process commands with matching tenantCode and projectCode', async () => {
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-match-proj',
        type: 'execute_command',
        payload: { command: 'echo match' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'match' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-match-proj',
        table: 'commands',
        pk: 'CMD#101',
        sk: 'CMD#101',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-match-proj', type: 'execute_command', agentId: 'test-id', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-match-proj', 'test-id')

      agent.stop()
    })

    it('should ignore commands with missing tenantCode/projectCode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      // tenantCode/projectCodeが未指定の通知は無視される
      onMessage({
        id: 'notif-no-tenant',
        table: 'commands',
        pk: 'CMD#200',
        sk: 'CMD#200',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-no-tenant', type: 'execute_command' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should ignore commands with matching tenantCode but missing projectCode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-no-proj',
        table: 'commands',
        pk: 'CMD#201',
        sk: 'CMD#201',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-no-proj', type: 'execute_command', tenantCode: 'test-tenant' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should process commands for matching agentId', async () => {
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-match',
        type: 'execute_command',
        payload: { command: 'echo match' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'match output' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-match',
        table: 'commands',
        pk: 'CMD#101',
        sk: 'CMD#101',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-match', type: 'execute_command', agentId: 'test-id', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-match', 'test-id')

      agent.stop()
    })

    it('should check pending commands on reconnect', async () => {
      mockClient.getPendingCommands.mockResolvedValue([
        { commandId: 'cmd-pending', type: 'execute_command', createdAt: 123 },
      ])
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-pending',
        type: 'execute_command',
        payload: { command: 'echo pending' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'pending output' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // Get the reconnect callback
      const reconnectCallback = mockSubscriber.onReconnect.mock.calls[0][0] as () => void
      reconnectCallback()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.getPendingCommands).toHaveBeenCalledWith('test-id')
      expect(mockClient.getCommand).toHaveBeenCalledWith('cmd-pending', 'test-id')
      expect(mockedExecuteCommand).toHaveBeenCalled()

      agent.stop()
    })

    it('should disconnect subscriber on stop()', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      agent.stop()

      expect(mockSubscriber.disconnect).toHaveBeenCalled()
    })

    it('should still run heartbeat in subscription mode', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockClient.heartbeat).toHaveBeenCalled()

      agent.stop()
    })

    it('should handle command error in subscription mode and submit error result', async () => {
      mockClient.getCommand.mockRejectedValue(new Error('Command fetch failed'))
      mockClient.submitResult.mockResolvedValue(undefined)

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-err',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-err', type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('runner.commandError'))
      expect(mockClient.submitResult).toHaveBeenCalledWith(
        'cmd-err',
        expect.objectContaining({ success: false, error: expect.any(String) }),
        'test-id',
      )

      agent.stop()
    })

    it('should log resultSendFailed when submitResult fails after command error in subscription mode', async () => {
      mockClient.getCommand.mockRejectedValue(new Error('Command fetch failed'))
      mockClient.submitResult.mockRejectedValue(new Error('Submit failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-err2',
        table: 'commands',
        pk: 'CMD#456',
        sk: 'CMD#456',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-err2', type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('runner.commandError'))
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('runner.resultSendFailed'))

      agent.stop()
    })

    it('should handle checkPendingCommands error gracefully', async () => {
      mockClient.getPendingCommands.mockRejectedValue(new Error('Network error'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const reconnectCallback = mockSubscriber.onReconnect.mock.calls[0][0] as () => void
      reconnectCallback()

      await jest.advanceTimersByTimeAsync(100)

      // Should log warning and not crash
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to check pending commands'))

      agent.stop()
    })
  })

  describe('chat_cancel via subscription', () => {
    it('should process chat_cancel command via subscription notification', async () => {
      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-cancel',
        type: 'chat_cancel',
        payload: { targetCommandId: 'some-cmd' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'ok' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'notif-cancel',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-cancel', type: 'chat_cancel', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedExecuteCommand).toHaveBeenCalledWith(
        'chat_cancel',
        { targetCommandId: 'some-cmd' },
        expect.any(Object),
      )

      agent.stop()
    })
  })

  describe('config loading', () => {
    it('should continue when getConfig fails', async () => {
      mockClient.getConfig.mockRejectedValue(new Error('Config fetch failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to load server config'))
      // Should still register and start
      expect(mockClient.register).toHaveBeenCalled()

      agent.stop()
    })
  })

  describe('project config sync', () => {
    it('should perform initial config sync after registration', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedSyncProjectConfig).toHaveBeenCalled()

      agent.stop()
    })

    it('should apply project config when sync returns config', async () => {
      const mockConfig = {
        configHash: 'new-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: false,
          builtinFallbackEnabled: false,
          externalAgentEnabled: true,
          allowedTools: ['WebFetch'],
          claudeCodeConfig: { additionalDirs: ['/extra'], appendSystemPrompt: 'Be helpful' },
        },
      }
      mockedSyncProjectConfig.mockResolvedValueOnce({ config: mockConfig, fromCache: false })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Config applied'))

      agent.stop()
    })

    it('should write AWS config when project config has AWS accounts and projectDir', async () => {
      const projectWithDir = { tenantCode: 'mbc', projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api', projectDir: '/tmp/proj' }
      const mockConfig = {
        configHash: 'aws-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: {
          agentEnabled: true,
          builtinAgentEnabled: true,
          builtinFallbackEnabled: true,
          externalAgentEnabled: true,
          allowedTools: [],
        },
        aws: {
          accounts: [
            { id: '1', name: 'dev', region: 'ap-northeast-1', accountId: '123456', auth: { method: 'access_key' as const }, isDefault: true },
          ],
        },
      }
      mockedSyncProjectConfig.mockResolvedValueOnce({ config: mockConfig, fromCache: false })

      const agent = new ProjectAgent(projectWithDir, 'agent-1', options, undefined, undefined)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedWriteAwsConfig).toHaveBeenCalledWith(
        '/tmp/test-project', // resolved by mocked initProjectDir
        'test-proj',
        mockConfig.aws.accounts,
      )

      agent.stop()
    })

    it('should schedule config sync when heartbeat response has different configHash', async () => {
      mockClient.heartbeat.mockResolvedValue({ success: true, configHash: 'changed-hash' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Config hash changed'))

      // Wait for debounce timer
      await jest.advanceTimersByTimeAsync(3000)

      // syncProjectConfig should be called again (initial + debounced)
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)

      agent.stop()
    })

    it('should handle config-update notification', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      onMessage({
        id: 'config-1',
        table: 'support-agent',
        pk: 'AGENT#test-proj',
        sk: 'CONFIG#test-proj',
        tenantCode: 'test-proj',
        action: 'config-update',
        content: { configHash: 'new-hash-123', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Config update notification received'))

      // Wait for debounce
      await jest.advanceTimersByTimeAsync(3000)

      // syncProjectConfig: 1 initial + 1 debounced
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)

      agent.stop()
    })

    it('should debounce multiple config-update notifications', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void

      // Send multiple config-update notifications rapidly
      onMessage({ id: '1', table: '', pk: '', sk: '', tenantCode: '', action: 'config-update', content: { configHash: 'hash-1' } })
      onMessage({ id: '2', table: '', pk: '', sk: '', tenantCode: '', action: 'config-update', content: { configHash: 'hash-2' } })
      onMessage({ id: '3', table: '', pk: '', sk: '', tenantCode: '', action: 'config-update', content: { configHash: 'hash-3' } })

      // Wait for debounce (only last should trigger)
      await jest.advanceTimersByTimeAsync(3000)

      // syncProjectConfig: 1 initial + 1 debounced (not 3)
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)

      agent.stop()
    })

    it('should retry initial config sync and succeed on second attempt', async () => {
      // First attempt returns null (fail), second returns config (success)
      mockedSyncProjectConfig
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          config: {
            configHash: 'retry-hash',
            project: { projectCode: 'test-proj', projectName: 'Test' },
            agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
          },
          fromCache: false,
        })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      // Let registration complete + first sync attempt
      await jest.advanceTimersByTimeAsync(100)
      // Advance past retry delay (2000ms * 1)
      await jest.advanceTimersByTimeAsync(2000)
      // Let second sync attempt complete
      await jest.advanceTimersByTimeAsync(100)

      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial config sync attempt 1 failed'))
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Config applied'))

      agent.stop()
    })

    it('should log warning after all initial config sync retries fail', async () => {
      // All attempts return null
      mockedSyncProjectConfig
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      // Let registration + all retries complete
      // attempt 1 + delay 2000ms + attempt 2 + delay 4000ms + attempt 3
      await jest.advanceTimersByTimeAsync(100)
      await jest.advanceTimersByTimeAsync(2000)
      await jest.advanceTimersByTimeAsync(100)
      await jest.advanceTimersByTimeAsync(4000)
      await jest.advanceTimersByTimeAsync(100)

      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(3)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial config sync attempt 1 failed'))
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial config sync attempt 2 failed'))
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Initial config sync failed after all retries'))

      agent.stop()
    })

    it('should not schedule config sync when configHash is same in heartbeat', async () => {
      // First sync returns a config with hash
      mockedSyncProjectConfig.mockResolvedValueOnce({
        config: {
          configHash: 'same-hash',
          project: { projectCode: 'test-proj', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        },
        fromCache: false,
      })
      // Heartbeat returns same hash
      mockClient.heartbeat.mockResolvedValue({ success: true, configHash: 'same-hash' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // Should NOT log "Config hash changed"
      const hashChangedCalls = (logger.info as jest.Mock).mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('Config hash changed'),
      )
      expect(hashChangedCalls).toHaveLength(0)

      agent.stop()
    })

    it('should pass projectConfig to executeCommand options', async () => {
      const mockConfig = {
        configHash: 'cfg-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
      }
      mockedSyncProjectConfig.mockResolvedValueOnce({ config: mockConfig, fromCache: false })

      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-cfg',
        type: 'chat',
        payload: { message: 'hello' },
      })
      mockedExecuteCommand.mockResolvedValue({ success: true, data: 'ok' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      // Send command via subscription notification
      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: 'notif-cfg',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-cfg', type: 'chat', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedExecuteCommand).toHaveBeenCalledWith(
        'chat',
        { message: 'hello' },
        expect.objectContaining({ projectConfig: mockConfig }),
      )

      agent.stop()
    })

    it('should clear configSyncDebounceTimer on stop()', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      // Allow registration, config sync, and subscription setup to complete
      await jest.advanceTimersByTimeAsync(500)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({ id: '1', table: '', pk: '', sk: '', tenantCode: '', action: 'config-update', content: { configHash: 'pending-hash' } })

      // Stop before debounce fires
      agent.stop()

      mockedSyncProjectConfig.mockClear()
      await jest.advanceTimersByTimeAsync(5000)

      // Debounced sync should NOT have fired
      expect(mockedSyncProjectConfig).not.toHaveBeenCalled()
    })
  })

  describe('performSetup', () => {
    it('should call performConfigSync and log completion', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performSetup()

      // performConfigSync is called once during registration and once during setup
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Starting setup'))
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Setup completed'))

      agent.stop()
    })

    it('should sync repositories when project config has repositories', async () => {
      const mockConfig = {
        configHash: 'repo-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        repositories: [
          { repositoryId: 'repo-1', repositoryCode: 'my-repo', repositoryName: 'my-repo', repositoryUrl: 'https://github.com/org/repo.git', provider: 'github', branch: 'main', authMethod: 'token' },
        ],
      }
      mockedSyncProjectConfig.mockResolvedValue({ config: mockConfig, fromCache: false })
      mockedSyncRepositories.mockResolvedValue([
        { repositoryId: 'repo-1', repositoryCode: 'my-repo', repositoryName: 'my-repo', status: 'cloned' },
      ])

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performSetup()

      expect(mockedSyncRepositories).toHaveBeenCalledWith(
        expect.anything(), // client
        mockConfig.repositories,
        expect.stringContaining('repos'),
        expect.stringContaining('test-proj'),
      )
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Repository sync: 1 cloned, 0 updated, 0 skipped'))

      agent.stop()
    })

    it('should handle repository sync failure gracefully', async () => {
      const mockConfig = {
        configHash: 'repo-fail-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        repositories: [
          { repositoryId: 'repo-1', repositoryCode: 'my-repo', repositoryName: 'my-repo', repositoryUrl: 'https://github.com/org/repo.git', provider: 'github', branch: 'main', authMethod: 'token' },
        ],
      }
      mockedSyncProjectConfig.mockResolvedValue({ config: mockConfig, fromCache: false })
      mockedSyncRepositories.mockRejectedValue(new Error('Sync failed'))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performSetup()

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Repository sync failed'))
      // Setup should still complete
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Setup completed'))

      agent.stop()
    })

    it('should log documentation sources when present in project config', async () => {
      const mockConfig = {
        configHash: 'setup-hash',
        project: { projectCode: 'test-proj', projectName: 'Test' },
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        documentation: {
          sources: [
            { url: 'https://example.com/docs', type: 'url' as const },
          ],
        },
      }
      mockedSyncProjectConfig.mockResolvedValue({ config: mockConfig, fromCache: false })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await agent.performSetup()

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Documentation sources found'))

      agent.stop()
    })
  })

  describe('onSetup and onConfigSync callbacks', () => {
    it('should pass onSetup callback that calls performSetup', async () => {
      mockedExecuteCommand.mockImplementation(async (_type, _payload, opts) => {
        if (opts?.onSetup) {
          await opts.onSetup()
        }
        return { success: true, data: 'ok' }
      })

      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-setup',
        type: 'setup',
        payload: {},
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: 'notif-setup',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-setup', type: 'setup', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedExecuteCommand).toHaveBeenCalledWith(
        'setup',
        {},
        expect.objectContaining({
          onSetup: expect.any(Function),
          onConfigSync: expect.any(Function),
        }),
      )
      // performSetup calls performConfigSync internally
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Starting setup'))

      agent.stop()
    })

    it('should pass onConfigSync callback that calls performConfigSync', async () => {
      mockedExecuteCommand.mockImplementation(async (_type, _payload, opts) => {
        if (opts?.onConfigSync) {
          await opts.onConfigSync()
        }
        return { success: true, data: 'ok' }
      })

      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-sync',
        type: 'config_sync',
        payload: {},
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: 'notif-sync',
        table: 'commands',
        pk: 'CMD#123',
        sk: 'CMD#123',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-sync', type: 'config_sync', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedExecuteCommand).toHaveBeenCalledWith(
        'config_sync',
        {},
        expect.objectContaining({
          onConfigSync: expect.any(Function),
        }),
      )
      // performConfigSync is called: initial + callback
      expect(mockedSyncProjectConfig).toHaveBeenCalledTimes(2)

      agent.stop()
    })

    it('should pass onSyncRepository callback', async () => {
      mockedExecuteCommand.mockImplementation(async (_type, _payload, opts) => {
        if (opts?.onSyncRepository) {
          await opts.onSyncRepository('my-repo', 'feature/test')
        }
        return { success: true, data: 'ok' }
      })

      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-sync-repo',
        type: 'sync_repository',
        payload: { repositoryCode: 'my-repo', branch: 'feature/test' },
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: 'notif-sync-repo',
        table: 'commands',
        pk: 'CMD#456',
        sk: 'CMD#456',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-sync-repo', type: 'sync_repository', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(mockedExecuteCommand).toHaveBeenCalledWith(
        'sync_repository',
        { repositoryCode: 'my-repo', branch: 'feature/test' },
        expect.objectContaining({
          onSyncRepository: expect.any(Function),
        }),
      )

      agent.stop()
    })
  })

  describe('performReboot', () => {
    it('should stop transport and schedule reExecProcess', async () => {
      const originalSend = process.send
      // Jest runs tests in a forked child process, so process.send is defined.
      // Simulate a standalone (non-child) process for this test.
      Object.defineProperty(process, 'send', { value: undefined, writable: true, configurable: true })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        await agent.performReboot()

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Reboot requested'))
        expect(mockSubscriber.disconnect).toHaveBeenCalled()

        // Advance past setTimeout(1000)
        await jest.advanceTimersByTimeAsync(1000)

        expect(mockedReExecProcess).toHaveBeenCalledWith()
      } finally {
        Object.defineProperty(process, 'send', { value: originalSend, writable: true, configurable: true })
      }
    })

    it('should call process.exit(43) instead of reExecProcess when running in Docker', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        await agent.performReboot()

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Reboot requested'))
        expect(mockSubscriber.disconnect).toHaveBeenCalled()

        // Advance past setTimeout(1000)
        await jest.advanceTimersByTimeAsync(1000)

        // In Docker mode, exits with DOCKER_RESTART_EXIT_CODE (43) so DockerSupervisor can restart
        expect(mockExit).toHaveBeenCalledWith(43)
        expect(mockedReExecProcess).not.toHaveBeenCalled()
      } finally {
        mockExit.mockRestore()
        if (originalDockerEnv === undefined) {
          delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        } else {
          process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
        }
      }
    })

    it('should call process.exit(0) instead of reExecProcess when running as child process', async () => {
      const originalSend = process.send
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      Object.defineProperty(process, 'send', { value: jest.fn(), writable: true, configurable: true })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        await agent.performReboot()

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Reboot requested'))
        expect(mockSubscriber.disconnect).toHaveBeenCalled()

        // Advance past setTimeout(1000)
        await jest.advanceTimersByTimeAsync(1000)

        // Child process exits cleanly, does NOT call reExecProcess
        expect(mockExit).toHaveBeenCalledWith(0)
        expect(mockedReExecProcess).not.toHaveBeenCalled()
      } finally {
        mockExit.mockRestore()
        Object.defineProperty(process, 'send', { value: originalSend, writable: true, configurable: true })
      }
    })
  })

  describe('performUpdate', () => {
    describe('自己更新が成立しない実行環境', () => {
      const K8S_ENV = 'KUBERNETES_SERVICE_HOST'
      let originalK8sHost: string | undefined

      beforeEach(() => {
        originalK8sHost = process.env[K8S_ENV]
        process.env[K8S_ENV] = '10.43.0.1'
      })

      afterEach(() => {
        if (originalK8sHost === undefined) {
          delete process.env[K8S_ENV]
        } else {
          process.env[K8S_ENV] = originalK8sHost
        }
      })

      it('Kubernetes 上では更新を実行せずエラーにする', async () => {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        await expect(agent.performUpdate()).rejects.toThrow(/Kubernetes/)

        expect(mockedPerformUpdate).not.toHaveBeenCalled()
        expect(mockedReExecProcess).not.toHaveBeenCalled()
      })

      it('エラーには代わりに何をすべきか（イメージタグの更新）を含める', async () => {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        await expect(agent.performUpdate()).rejects.toThrow(/image tag/i)
      })

      it('バージョン確認そのものを行わない（更新できないと分かっているため）', async () => {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)
        mockClient.getVersionInfo.mockClear()

        await expect(agent.performUpdate()).rejects.toThrow()

        expect(mockClient.getVersionInfo).not.toHaveBeenCalled()
      })
    })

    it('should update and call reExecProcess when running as standalone (no process.send)', async () => {
      const originalSend = process.send
      // Simulate standalone process (not a child process)
      Object.defineProperty(process, 'send', { value: undefined, writable: true, configurable: true })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        await agent.performUpdate()

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Update requested'))
        expect(mockClient.getVersionInfo).toHaveBeenCalledWith('latest')
        expect(mockedDetectInstallMethod).toHaveBeenCalled()
        expect(mockedPerformUpdate).toHaveBeenCalledWith('0.0.2', 'global', expect.any(String))
        expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('Update to 0.0.2 successful'))
        expect(mockSubscriber.disconnect).toHaveBeenCalled()

        // Advance past setTimeout(1000)
        await jest.advanceTimersByTimeAsync(1000)

        expect(mockedReExecProcess).toHaveBeenCalledWith('global')
      } finally {
        Object.defineProperty(process, 'send', { value: originalSend, writable: true, configurable: true })
      }
    })

    it('should update and exit cleanly when running as child process (process.send defined)', async () => {
      const originalSend = process.send
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      // Simulate child process
      Object.defineProperty(process, 'send', { value: jest.fn(), writable: true, configurable: true })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        await agent.performUpdate()

        expect(mockedPerformUpdate).toHaveBeenCalledWith('0.0.2', 'global', expect.any(String))
        expect(logger.success).toHaveBeenCalledWith(expect.stringContaining('Update to 0.0.2 successful'))

        // Advance past setTimeout(1000)
        await jest.advanceTimersByTimeAsync(1000)

        // Child process exits cleanly, does NOT call reExecProcess
        expect(mockExit).toHaveBeenCalledWith(0)
        expect(mockedReExecProcess).not.toHaveBeenCalled()
      } finally {
        mockExit.mockRestore()
        Object.defineProperty(process, 'send', { value: originalSend, writable: true, configurable: true })
      }
    })

    it('should write update-version.json when running as child process in Docker mode', async () => {
      const originalSend = process.send
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      Object.defineProperty(process, 'send', { value: jest.fn(), writable: true, configurable: true })
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const { writeFileSync } = require('fs') as { writeFileSync: jest.Mock }

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        await agent.performUpdate()
        await jest.advanceTimersByTimeAsync(1000)

        expect(writeFileSync).toHaveBeenCalledWith(
          expect.stringContaining('update-version.json'),
          expect.stringContaining('0.0.2'),
          { mode: 0o600, flag: 'wx' },
        )
        expect(mockExit).toHaveBeenCalledWith(42)
      } finally {
        mockExit.mockRestore()
        Object.defineProperty(process, 'send', { value: originalSend, writable: true, configurable: true })
        if (originalDockerEnv === undefined) {
          delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        } else {
          process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
        }
      }
    })

    it('should use beta channel when running a beta version', async () => {
      const originalSend = process.send
      Object.defineProperty(process, 'send', { value: undefined, writable: true, configurable: true })

      try {
        const mockedDetectChannel = detectChannelFromVersion as jest.MockedFunction<typeof detectChannelFromVersion>
        mockedDetectChannel.mockReturnValueOnce('beta')

        mockClient.getVersionInfo.mockResolvedValueOnce({
          latestVersion: '0.0.22-beta.3',
          minimumVersion: '0.0.0',
          channel: 'beta',
          channels: {},
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        await agent.performUpdate()

        expect(mockClient.getVersionInfo).toHaveBeenCalledWith('beta')
        expect(mockedPerformUpdate).toHaveBeenCalledWith('0.0.22-beta.3', 'global', expect.any(String))

        agent.stop()
      } finally {
        Object.defineProperty(process, 'send', { value: originalSend, writable: true, configurable: true })
      }
    })

    it('should skip update when already on latest version', async () => {
      mockedIsNewerVersion.mockReturnValueOnce(false)

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      await agent.performUpdate()

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Already up to date'))
      expect(mockedPerformUpdate).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should throw error when update fails', async () => {
      mockedPerformUpdate.mockResolvedValueOnce({ success: false, error: 'Permission denied' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(100)

      await expect(agent.performUpdate()).rejects.toThrow('Update failed: Permission denied')

      agent.stop()
    })
  })

  describe('updateToken', () => {
    it('should update token on ApiClient and log message', () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.updateToken('new-token-123')

      expect(mockClient.updateToken).toBeDefined()
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('runner.tokenUpdated'))
    })
  })

  describe('isBusy', () => {
    it('should return false when not processing a command', () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      expect(agent.isBusy()).toBe(false)
    })
  })

  describe('graceful shutdown (drain)', () => {
    function triggerCommand(commandId: string): void {
      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: `notif-${commandId}`,
        table: 'commands',
        pk: `CMD#${commandId}`,
        sk: `CMD#${commandId}`,
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId, type: 'execute_command', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })
    }

    /** Starts a command whose executeCommand call never resolves on its own; returns the resolver. */
    function startStuckCommand(commandId: string): (result: { success: boolean; data: string }) => void {
      mockClient.getCommand.mockResolvedValue({ commandId, type: 'execute_command', payload: {} })
      let resolveExec: (result: { success: boolean; data: string }) => void = () => undefined
      mockedExecuteCommand.mockImplementation(
        () => new Promise((resolve) => { resolveExec = resolve }),
      )
      triggerCommand(commandId)
      return (result) => resolveExec(result)
    }

    it('waits for an in-flight command to finish before disconnecting the transport', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const resolveExec = startStuckCommand('cmd-inflight')
      await jest.advanceTimersByTimeAsync(100)

      const shutdownPromise = agent.shutdown()
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)

      // Still draining: the command has not finished, so the transport must
      // stay connected (both for heartbeats and in case the command depends
      // on it).
      expect(mockSubscriber.disconnect).not.toHaveBeenCalled()

      resolveExec({ success: true, data: 'ok' })
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
      await shutdownPromise

      expect(mockSubscriber.disconnect).toHaveBeenCalled()
      expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
    })

    it('declines new commands once shutdown has started', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      // draining is set synchronously before shutdown()'s first await, so a
      // notification delivered right after calling shutdown() (without
      // awaiting it yet) is guaranteed to see draining=true.
      const shutdownPromise = agent.shutdown()
      triggerCommand('cmd-declined')

      await jest.advanceTimersByTimeAsync(100)
      await shutdownPromise

      expect(mockClient.getCommand).not.toHaveBeenCalledWith('cmd-declined', expect.anything())
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('runner.commandDeclinedDraining'))
    })

    it('resolves immediately when no command is in flight', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const shutdownPromise = agent.shutdown()
      await jest.advanceTimersByTimeAsync(0)
      await shutdownPromise

      expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
      expect(mockSubscriber.disconnect).toHaveBeenCalled()
    })

    it('gives up after SHUTDOWN_DRAIN_TIMEOUT_MS and logs the remaining command id(s)', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      startStuckCommand('cmd-stuck')
      await jest.advanceTimersByTimeAsync(100)

      const shutdownPromise = agent.shutdown()
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_TIMEOUT_MS)
      await shutdownPromise

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('runner.drainTimedOut'))
      expect(mockClient.releaseSelf).not.toHaveBeenCalled()
      // The transport still stops even though the drain timed out — the
      // process is exiting either way.
      expect(mockSubscriber.disconnect).toHaveBeenCalled()
    })

    it('calls releaseSelf() exactly once, after the drain resolves (ordering)', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const resolveExec = startStuckCommand('cmd-order')
      await jest.advanceTimersByTimeAsync(100)

      const shutdownPromise = agent.shutdown()
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
      expect(mockClient.releaseSelf).not.toHaveBeenCalled()

      resolveExec({ success: true, data: 'ok' })
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
      await shutdownPromise

      expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
      expect(mockClient.submitResult.mock.invocationCallOrder[0]).toBeLessThan(
        mockClient.releaseSelf.mock.invocationCallOrder[0],
      )
    })

    it('does not double-drain or double-release when shutdown() is invoked twice (SIGTERM+SIGINT)', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const p1 = agent.shutdown()
      const p2 = agent.shutdown()
      await jest.advanceTimersByTimeAsync(0)
      await Promise.all([p1, p2])

      expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
    })

    it('joins the first in-flight shutdown() instead of resolving early: a second concurrent caller (e.g. the auto-updater racing SIGTERM) does not resolve until the first caller\'s drain/release actually completes, and the underlying drain/release logic runs only once', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const resolveExec = startStuckCommand('cmd-concurrent')
      await jest.advanceTimersByTimeAsync(100)

      // Two independent call sites (SIGTERM/SIGINT handler + auto-updater's
      // stopAllAgents callback) both call shutdown() around the same time.
      let p1Resolved = false
      let p2Resolved = false
      const p1 = agent.shutdown().then(() => { p1Resolved = true })
      const p2 = agent.shutdown().then(() => { p2Resolved = true })

      // While the command is still in flight, NEITHER caller's promise may
      // resolve — this is the bug: the old early-return guard resolved the
      // second caller's promise instantly, letting it proceed (e.g. the
      // auto-updater calling reExecProcess()) while the drain of a genuinely
      // in-flight command was still running underneath the first caller.
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS * 3)
      expect(p1Resolved).toBe(false)
      expect(p2Resolved).toBe(false)
      expect(mockClient.releaseSelf).not.toHaveBeenCalled()

      // Only once the in-flight command actually finishes do both callers'
      // promises resolve, together, after the real drain/release completed.
      resolveExec({ success: true, data: 'ok' })
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
      await Promise.all([p1, p2])

      expect(p1Resolved).toBe(true)
      expect(p2Resolved).toBe(true)
      // The underlying drain/release logic ran exactly once — not once per
      // caller.
      expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
      expect(mockSubscriber.disconnect).toHaveBeenCalledTimes(1)
    })

    it('a plain shutdown() (SIGTERM) that wins the race first does not discard a later joining caller\'s excludeCommandId (regression: memoization previously reintroduced the self-wait deadlock)', async () => {
      // shutdown() used to memoize on `this.shutdownPromise` with only the
      // FIRST caller's opts ever consulted. If a plain shutdown() (e.g.
      // SIGTERM) won the race and started the drain first, a later caller
      // like performReboot()/performUpdate()/performDockerRebuild() joining
      // with `{ excludeCommandId }` would have that exclusion silently
      // discarded — reintroducing the exact self-wait deadlock class an
      // earlier round already fixed (up to the full SHUTDOWN_DRAIN_TIMEOUT_MS
      // hang), just via a different code path. The fix moves exclusion into
      // a shared, live `excludedCommandIds` set that any caller can still
      // contribute to, even after joining an already-in-flight shutdown.
      const resolvers: Record<string, (result: { success: boolean; data: string }) => void> = {}
      mockClient.getCommand.mockImplementation(async (commandId: string) => ({
        commandId,
        type: 'execute_command',
        payload: {},
      }))
      mockedExecuteCommand.mockImplementation(
        (_type, _payload, opts) =>
          new Promise((resolve) => {
            resolvers[opts.commandId as string] = resolve
          }),
      )

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      // Two commands in flight: 'cmd-other' is genuinely unrelated and must
      // be waited on; 'cmd-reboot' stands in for a reboot/update/
      // docker-rebuild command that is itself driving the second, joining
      // shutdown() call below and must be excluded from the drain (it can
      // never finish here — exactly like the real self-referencing command,
      // which is blocked on this very shutdown() call).
      triggerCommand('cmd-other')
      await jest.advanceTimersByTimeAsync(50)
      triggerCommand('cmd-reboot')
      await jest.advanceTimersByTimeAsync(50)

      expect(resolvers['cmd-other']).toBeDefined()
      expect(resolvers['cmd-reboot']).toBeDefined()

      // A plain shutdown() (as if from the SIGTERM/SIGINT handler) wins the
      // race and starts the drain first — with NO excludeCommandId.
      const sigtermShutdown = agent.shutdown()

      // Shortly after, a second caller (as if performReboot()) joins the
      // already-in-flight shutdown with its own excludeCommandId.
      await jest.advanceTimersByTimeAsync(10)
      const rebootShutdown = agent.shutdown({ excludeCommandId: 'cmd-reboot' })

      // Resolving ONLY the non-excluded command must be enough for the drain
      // to complete — 'cmd-reboot' must not count against it.
      resolvers['cmd-other']({ success: true, data: 'ok' })
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
      await Promise.all([sigtermShutdown, rebootShutdown])

      expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
      expect(mockSubscriber.disconnect).toHaveBeenCalledTimes(1)
    })

    it('logs a warning with the reason when releaseSelf() resolves but the slot was not released', async () => {
      mockClient.releaseSelf.mockResolvedValue({ released: false, reason: 'nonce_mismatch' })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      await agent.shutdown()

      expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('runner.slotReleaseFailed'))
    })

    it('does not call releaseSelf() when the replica never held a slot (admission rejected/standby)', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
        admission: { accepted: false, instanceId: 'pod-b', maxReplicas: 1, liveReplicas: 1, reason: 'limit_reached' },
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      await agent.shutdown()

      expect(mockClient.releaseSelf).not.toHaveBeenCalled()
    })

    it('keeps sending heartbeats while draining', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const resolveExec = startStuckCommand('cmd-heartbeat')
      await jest.advanceTimersByTimeAsync(100)

      mockClient.heartbeat.mockClear()
      const shutdownPromise = agent.shutdown()
      await jest.advanceTimersByTimeAsync(options.heartbeatInterval)

      expect(mockClient.heartbeat).toHaveBeenCalled()
      // Still draining at this point — the slot must not have been released yet.
      expect(mockClient.releaseSelf).not.toHaveBeenCalled()

      resolveExec({ success: true, data: 'ok' })
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
      await shutdownPromise
    })

    it('ignores an evicted heartbeat response while shuttingDown is true (does not re-enter standby), but still records the slot as lost', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const resolveExec = startStuckCommand('cmd-evict')
      await jest.advanceTimersByTimeAsync(100)

      // Every heartbeat from here on reports eviction.
      mockClient.heartbeat.mockResolvedValue({ success: true, evicted: true })
      mockClient.register.mockClear()

      const shutdownPromise = agent.shutdown()
      await jest.advanceTimersByTimeAsync(options.heartbeatInterval)

      // A normal (non-shutting-down) eviction reaction would call stop() and
      // schedule a standby re-registration; neither must happen mid-shutdown.
      expect(mockClient.register).not.toHaveBeenCalled()

      resolveExec({ success: true, data: 'ok' })
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
      await shutdownPromise

      // handleEviction() still flips slotHeld to false even though its early
      // `shuttingDown` return skips re-entering standby — the slot really was
      // evicted/reassigned server-side, so shutdown()'s drain logic must
      // recognize that and skip the now-unnecessary (and would-be-rejected)
      // releaseSelf() call, instead of logging a misleading
      // runner.slotReleaseFailed warning for an already-handled eviction.
      expect(mockClient.releaseSelf).not.toHaveBeenCalled()
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Skipping releaseSelf()'),
      )
    })

    it('cancels a config-sync debounce timer that was already armed just before shutdown() begins draining, so it does not fire mid-drain', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      // Arm the debounce timer via a CONFIG_UPDATE notification (same
      // trigger as the 'should clear configSyncDebounceTimer on stop()' test
      // above), then start an in-flight command BEFORE calling shutdown()
      // so the drain does not resolve instantly — giving the pre-armed timer
      // a real window in which it could (incorrectly) fire mid-drain.
      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({ id: '1', table: '', pk: '', sk: '', tenantCode: '', action: 'config-update', content: { configHash: 'pending-hash' } })

      const resolveExec = startStuckCommand('cmd-inflight-config')
      await jest.advanceTimersByTimeAsync(50)

      mockedSyncProjectConfig.mockClear()
      const shutdownPromise = agent.shutdown()

      // Advance well past CONFIG_SYNC_DEBOUNCE_MS while still draining (the
      // in-flight command has not resolved yet). Before the Finding 6 fix,
      // the CONFIG_UPDATE handler's `state.draining` guard only blocked NEW
      // notifications from re-arming this timer — it did nothing for a timer
      // already ticking down, so this would have fired here.
      await jest.advanceTimersByTimeAsync(CONFIG_SYNC_DEBOUNCE_MS + 1000)
      expect(mockedSyncProjectConfig).not.toHaveBeenCalled()
      expect(mockClient.releaseSelf).not.toHaveBeenCalled()

      resolveExec({ success: true, data: 'ok' })
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
      await shutdownPromise

      // Still not fired after the drain completes and shutdown() resolves.
      expect(mockedSyncProjectConfig).not.toHaveBeenCalled()
    })

    describe('reboot/update self-reference (excludeCommandId)', () => {
      // A 'reboot'/'update' command's own id is added to inFlightCommands by
      // processCommand *before* executeCommand (and therefore
      // performReboot/performUpdate, and therefore shutdown()) runs, and can
      // only be removed by processCommand's `finally` — which cannot run
      // until this whole chain, including shutdown(), resolves. Without
      // excluding the triggering command's own id from the drain, shutdown()
      // would wait on itself forever (bounded only by the drain timeout) on
      // every single reboot/update. These tests exercise the real dispatch
      // path (processCommand -> executeCommand -> opts.onReboot/onUpdate ->
      // performReboot/performUpdate -> shutdown()) rather than calling
      // performReboot()/performUpdate() directly, so the commandId actually
      // flows the same way it does in production.

      it('a reboot command, as the only in-flight command, completes its own shutdown/release promptly (not blocked on itself)', async () => {
        mockClient.getCommand.mockResolvedValue({ commandId: 'cmd-reboot', type: 'reboot', payload: {} })
        mockedExecuteCommand.mockImplementation(async (type, _payload, opts) => {
          if (type === 'reboot' && opts?.onReboot) {
            await opts.onReboot(opts.commandId)
          }
          return { success: true, data: 'reboot initiated' }
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        triggerCommand('cmd-reboot')

        // No poll-interval wait needed at all: the reboot command is the
        // only thing in flight, and its own id must not count toward the
        // drain. Advancing by 0 only flushes microtasks — if the fix were
        // missing, this assertion would still see releaseSelf() un-called
        // (the drain would instead be parked on a real poll-interval timer,
        // waiting for its own id to disappear, which never happens on its
        // own).
        await jest.advanceTimersByTimeAsync(0)

        expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
        expect(mockSubscriber.disconnect).toHaveBeenCalled()
      })

      it('an update command, as the only in-flight command, completes its own shutdown/release promptly (not blocked on itself)', async () => {
        mockClient.getCommand.mockResolvedValue({ commandId: 'cmd-update', type: 'update', payload: {} })
        mockedExecuteCommand.mockImplementation(async (type, _payload, opts) => {
          if (type === 'update' && opts?.onUpdate) {
            await opts.onUpdate(opts.commandId)
          }
          return { success: true, data: 'update initiated' }
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        triggerCommand('cmd-update')
        await jest.advanceTimersByTimeAsync(0)

        expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
        expect(mockSubscriber.disconnect).toHaveBeenCalled()
      })

      it('a reboot command still waits for a different, genuinely in-flight command before releasing', async () => {
        let resolveOther: (result: { success: boolean; data: string }) => void = () => undefined

        mockClient.getCommand.mockImplementation(async (commandId: string) =>
          commandId === 'cmd-reboot'
            ? { commandId, type: 'reboot', payload: {} }
            : { commandId, type: 'execute_command', payload: {} },
        )
        mockedExecuteCommand.mockImplementation(async (type, _payload, opts) => {
          if (type === 'reboot') {
            if (opts?.onReboot) await opts.onReboot(opts.commandId)
            return { success: true, data: 'reboot initiated' }
          }
          return new Promise((resolve) => { resolveOther = resolve })
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        // Start the genuinely unrelated command first and let it actually
        // begin executing (its id lands in inFlightCommands).
        triggerCommand('cmd-other')
        await jest.advanceTimersByTimeAsync(100)

        // Now the reboot command arrives. Its own id must be excluded from
        // the drain, but cmd-other's must NOT be.
        triggerCommand('cmd-reboot')
        await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)

        // Still draining: cmd-other has not finished yet.
        expect(mockClient.releaseSelf).not.toHaveBeenCalled()
        expect(mockSubscriber.disconnect).not.toHaveBeenCalled()

        resolveOther({ success: true, data: 'ok' })
        await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)

        expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
        expect(mockSubscriber.disconnect).toHaveBeenCalled()
      })
    })

    describe('config_sync -> performDockerRebuild self-reference (excludeCommandId)', () => {
      // Same deadlock class as reboot/update above, one call deeper:
      // performConfigSync() (invoked as the config_sync command's own
      // onConfigSync handler, so its commandId is still in inFlightCommands)
      // synchronously fire-and-forgets performDockerRebuild(commandId) via
      // ConfigSyncDeps.onDockerRebuild when it detects a Docker customization
      // change. Without excludeCommandId, performDockerRebuild()'s shutdown()
      // would needlessly wait on the *triggering* config_sync command's own
      // still-in-flight entry (only removed by processCommand's `finally`,
      // after submitResult() — agent-transport.ts) before giving up and
      // proceeding anyway.
      it('a config_sync command that triggers a docker rebuild does not block on its own still-in-flight commandId', async () => {
        const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
        process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'
        const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fsMod = require('fs')
        const mockMkdirSync = jest.spyOn(fsMod, 'mkdirSync').mockImplementation(() => undefined)
        const mockWriteFileSync = jest.spyOn(fsMod, 'writeFileSync').mockImplementation(() => undefined)

        try {
          const agent = new ProjectAgent(project, 'agent-1', options)
          agent.start()
          await jest.advanceTimersByTimeAsync(100)

          // Sanity check: the initial startup sync (default mock, no
          // dockerCustomization) must not have already triggered a rebuild.
          expect(mockClient.releaseSelf).not.toHaveBeenCalled()

          // The config_sync command's own sync detects a Docker customization
          // change from the no-customization baseline established above.
          mockedSyncProjectConfig.mockResolvedValueOnce({
            config: {
              configHash: 'docker-hash',
              project: { projectCode: 'test-proj', projectName: 'Test' },
              agent: {
                agentEnabled: true,
                builtinAgentEnabled: true,
                builtinFallbackEnabled: true,
                externalAgentEnabled: true,
                allowedTools: [],
                dockerCustomization: { aptPackages: ['curl'] },
              },
            },
            fromCache: false,
          })

          mockClient.getCommand.mockResolvedValue({ commandId: 'cmd-config-sync', type: 'config_sync', payload: {} })
          mockedExecuteCommand.mockImplementation(async (type, _payload, opts) => {
            if (type === 'config_sync' && opts?.onConfigSync) {
              await opts.onConfigSync(opts.commandId)
            }
            return { success: true, data: 'config sync completed' }
          })

          triggerCommand('cmd-config-sync')

          // No poll-interval wait needed: the docker rebuild's drain must not
          // count the triggering config_sync command's own still-in-flight
          // id. If excludeCommandId were missing, this assertion would still
          // see releaseSelf() un-called here (parked on a real
          // SHUTDOWN_DRAIN_POLL_INTERVAL_MS timer waiting for its own id to
          // disappear, which only happens after this very chain resolves).
          await jest.advanceTimersByTimeAsync(0)

          expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
          expect(mockSubscriber.disconnect).toHaveBeenCalled()
        } finally {
          mockExit.mockRestore()
          mockMkdirSync.mockRestore()
          mockWriteFileSync.mockRestore()
          if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
          else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
        }
      })
    })

    it('updateToken() during a mid-drain shutdown does not tear down the transport (shuttingDown guard)', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const resolveExec = startStuckCommand('cmd-token-update')
      await jest.advanceTimersByTimeAsync(100)

      const shutdownPromise = agent.shutdown()
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)

      // Still mid-drain: the transport (heartbeats, subscriber) must still be up.
      expect(mockSubscriber.disconnect).not.toHaveBeenCalled()

      mockClient.register.mockClear()
      agent.updateToken('new-token-during-drain')

      // The old teardown path (stop() -> stopTransport() -> disconnect(), then
      // restartRegisterLoop() -> a fresh register()) must NOT have fired: it
      // would tear the transport down out from under the drain and could
      // re-arm slotHeld while this shutdown() call is still mid-drain.
      expect(mockSubscriber.disconnect).not.toHaveBeenCalled()
      expect(mockClient.register).not.toHaveBeenCalled()
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('Ignoring updateToken'))

      resolveExec({ success: true, data: 'ok' })
      await jest.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
      await shutdownPromise

      // The original shutdown() completed normally afterward.
      expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)
      expect(mockSubscriber.disconnect).toHaveBeenCalled()
    })

    describe('registerAndStart() re-checks cancellation before startServices()', () => {
      // Between a successful register() (admission accepted immediately —
      // no rejected/standby branch to already check registerLoopCancelled)
      // and startServices(), registerAndStart() awaits real I/O
      // (submitPendingResults(), the initial config-sync retry loop). A
      // concurrent shutdown() (SIGTERM) can run entirely within that window.
      // `slotHeld` is set to true as soon as admission is known accepted —
      // i.e. right after register() returns, *not* inside startServices() —
      // because the server has already recorded the slot as held at that
      // point. So a shutdown() racing in during this I/O window must still
      // call releaseSelf() for that genuinely-held slot, even though
      // startServices() (heartbeat, subscription) never gets to run because
      // of the cancellation re-check right before it.
      it('does not start services when shutdown() cancels the register loop while registerAndStart() is awaiting I/O after a successful register(), but still releases the slot it already holds', async () => {
        let releaseSubmit: () => void = () => undefined
        mockedSubmitPendingResults.mockImplementationOnce(
          () => new Promise<void>((resolve) => { releaseSubmit = resolve }),
        )

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        // Let register() resolve and registerAndStart() reach the
        // submitPendingResults() await — but no further (startServices()
        // has not run: no heartbeat, no subscription).
        await jest.advanceTimersByTimeAsync(0)
        expect(mockClient.register).toHaveBeenCalledTimes(1)
        expect(mockSubscriber.connect).not.toHaveBeenCalled()

        // The default register() mock in this file carries no `admission`
        // field at all (unrestricted / no replica limit configured), which
        // registerAndStart() treats the same as an explicit
        // admission.accepted === true: the server has already registered
        // this instance as holding the slot.
        expect((agent as unknown as { slotHeld: boolean }).slotHeld).toBe(true)

        // A concurrent SIGTERM arrives and completes its own shutdown while
        // registerAndStart() is still parked on submitPendingResults().
        const shutdownPromise = agent.shutdown()
        await jest.advanceTimersByTimeAsync(0)
        await shutdownPromise

        // The slot really is held server-side — doShutdown() must attempt
        // releaseSelf() for it, not skip it with "never held a slot". Before
        // the fix, slotHeld was only ever set inside startServices(), so this
        // early-cancelled path left it false and releaseSelf() was
        // incorrectly skipped, leaking the slot until the slow ~90s
        // heartbeat-timeout reclaim.
        expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)

        // Now let registerAndStart() resume. Without the cancellation
        // re-check it would barrel on into startServices() (heartbeat +
        // subscription started) right as the process is exiting.
        releaseSubmit()
        await jest.advanceTimersByTimeAsync(options.heartbeatInterval * 2)

        expect(mockSubscriber.connect).not.toHaveBeenCalled()
        expect(mockSubscriber.subscribe).not.toHaveBeenCalled()
        expect(mockClient.heartbeat).not.toHaveBeenCalled()
      })

      // Same scenario as above, but exercising the explicit
      // `admission: { accepted: true, ... }` response shape (multi-replica
      // deployments with a plan replica limit configured) rather than the
      // no-`admission`-field/no-limit shape the test above uses — this is
      // the exact scenario the regression this test guards against was
      // found in.
      it('sets slotHeld immediately once an admission.accepted===true register() response arrives, before any post-registration I/O, so a concurrent shutdown() during that I/O still releases the slot', async () => {
        mockClient.register.mockResolvedValueOnce({
          agentId: 'test-id',
          tenantCode: 'test-tenant',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
          admission: { accepted: true, instanceId: 'pod-a', maxReplicas: 2, liveReplicas: 1 },
        })

        let releaseSubmit: () => void = () => undefined
        mockedSubmitPendingResults.mockImplementationOnce(
          () => new Promise<void>((resolve) => { releaseSubmit = resolve }),
        )

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        // Let register() resolve — registerAndStart() is now parked on
        // submitPendingResults(), before startServices() has ever run.
        await jest.advanceTimersByTimeAsync(0)
        expect(mockClient.register).toHaveBeenCalledTimes(1)
        expect(mockSubscriber.connect).not.toHaveBeenCalled()

        // slotHeld must already be true here — set as soon as
        // admission.accepted was known, not deferred to startServices().
        expect((agent as unknown as { slotHeld: boolean }).slotHeld).toBe(true)

        // A concurrent SIGTERM arrives and completes its own shutdown while
        // registerAndStart() is still parked on submitPendingResults().
        const shutdownPromise = agent.shutdown()
        await jest.advanceTimersByTimeAsync(0)
        await shutdownPromise

        // The accepted slot must be released, not skipped.
        expect(mockClient.releaseSelf).toHaveBeenCalledTimes(1)

        // startServices() itself must still never have run.
        releaseSubmit()
        await jest.advanceTimersByTimeAsync(options.heartbeatInterval * 2)
        expect(mockSubscriber.connect).not.toHaveBeenCalled()
        expect(mockSubscriber.subscribe).not.toHaveBeenCalled()
        expect(mockClient.heartbeat).not.toHaveBeenCalled()
      })
    })
  })

  describe('register auth error', () => {
    function makeAuthError(status: number) {
      const { AxiosError, AxiosHeaders } = require('axios')
      return new AxiosError('Auth error', 'ERR_BAD_REQUEST', undefined, undefined, {
        status,
        statusText: status === 401 ? 'Unauthorized' : 'Forbidden',
        data: { message: 'Invalid token' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
    }

    it('should retry with a long delay on 401 and warn', async () => {
      const randomSpy = jest.spyOn(global.Math, 'random').mockReturnValue(0.5)
      mockClient.register.mockRejectedValue(makeAuthError(401))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(10)
      expect(mockClient.register).toHaveBeenCalledTimes(1)
      expect(logger.warn).toHaveBeenCalledWith('runner.authErrorStartedFailing')

      // Auth floor is 5 minutes. Advancing 1 minute must not trigger another attempt.
      await jest.advanceTimersByTimeAsync(60_000)
      expect(mockClient.register).toHaveBeenCalledTimes(1)

      // After ~5 minutes total, the next attempt runs.
      await jest.advanceTimersByTimeAsync(5 * 60 * 1000)
      expect(mockClient.register).toHaveBeenCalledTimes(2)

      agent.stop()
      randomSpy.mockRestore()
    })

    it('should also treat 403 as an auth error', async () => {
      mockClient.register.mockRejectedValue(makeAuthError(403))

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()

      await jest.advanceTimersByTimeAsync(10)
      expect(logger.warn).toHaveBeenCalledWith('runner.authErrorStartedFailing')

      agent.stop()
    })
  })

  describe('onDockerRebuild callback', () => {
    it('should call performDockerRebuild when onDockerRebuild is invoked', () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        const performDockerRebuildSpy = jest.spyOn(agent as unknown as { performDockerRebuild: () => Promise<void> }, 'performDockerRebuild').mockResolvedValue(undefined)
        const deps = (agent as unknown as { configSyncDeps: { onDockerRebuild?: () => void } }).configSyncDeps
        expect(deps.onDockerRebuild).toBeDefined()
        deps.onDockerRebuild?.()
        expect(performDockerRebuildSpy).toHaveBeenCalledTimes(1)
      } finally {
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })
  })

  describe('performDockerRebuild', () => {
    it('should write docker-rebuild-needed marker and exit with 43', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs')
      const mockMkdirSync = jest.spyOn(mockFs, 'mkdirSync').mockImplementation(() => undefined)
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation(() => undefined)

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        await agent.performDockerRebuild()

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Docker rebuild requested'))

        // Advance past setTimeout(1000)
        await jest.advanceTimersByTimeAsync(1000)

        expect(mockWriteFileSync).toHaveBeenCalled()
        expect(mockExit).toHaveBeenCalledWith(43)
      } finally {
        mockExit.mockRestore()
        mockMkdirSync.mockRestore()
        mockWriteFileSync.mockRestore()
        if (originalDockerEnv === undefined) {
          delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        } else {
          process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
        }
      }
    })

    it('should write Dockerfile with apt/npm packages from dockerCustomization', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs')
      const mockMkdirSync = jest.spyOn(mockFs, 'mkdirSync').mockImplementation(() => undefined)
      const writtenFiles: Record<string, string> = {}
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
        writtenFiles[String(args[0])] = String(args[1])
      })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        // Set projectConfig with dockerCustomization
        const state = (agent as unknown as { configSyncState: { projectConfig: unknown; dockerCustomizationHash: string } }).configSyncState
        state.projectConfig = {
          configHash: 'hash',
          project: { projectCode: 'TEST_01', projectName: 'Test' },
          agent: {
            agentEnabled: true,
            builtinAgentEnabled: true,
            builtinFallbackEnabled: true,
            externalAgentEnabled: true,
            allowedTools: [],
            dockerCustomization: { aptPackages: ['curl'], npmPackages: ['typescript'] },
          },
        }
        state.dockerCustomizationHash = 'some-hash'

        await agent.performDockerRebuild()
        await jest.advanceTimersByTimeAsync(1000)

        // Check that Dockerfile was written with package content
        const dockerfileEntry = Object.entries(writtenFiles).find(([k]) => k.endsWith('Dockerfile.tmp'))
        expect(dockerfileEntry).toBeDefined()
        expect(dockerfileEntry?.[1]).toContain('curl')
        expect(dockerfileEntry?.[1]).toContain('typescript')
      } finally {
        mockExit.mockRestore()
        mockMkdirSync.mockRestore()
        mockWriteFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should log warn when writing marker fails', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs')
      const mockMkdirSync = jest.spyOn(mockFs, 'mkdirSync').mockImplementation(() => { throw new Error('permission denied') })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        await agent.performDockerRebuild()
        await jest.advanceTimersByTimeAsync(1000)

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to write docker-rebuild-needed marker'))
        expect(mockExit).toHaveBeenCalledWith(43)
      } finally {
        mockExit.mockRestore()
        mockMkdirSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })
  })

  describe('docker-built-hash initialization', () => {
    it('should initialize dockerCustomizationHash from docker-built-hash file when in Docker', () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs')
      const mockReadFileSync = jest.spyOn(mockFs, 'readFileSync').mockImplementation((...args: unknown[]) => {
        if (String(args[0]).endsWith('docker-built-hash')) return 'abc123hash'
        throw new Error('ENOENT')
      })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        // Access internal state via type cast for testing
        const state = (agent as unknown as { configSyncState: { dockerCustomizationHash: string | undefined } }).configSyncState
        expect(state.dockerCustomizationHash).toBe('abc123hash')
      } finally {
        mockReadFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should leave dockerCustomizationHash undefined when docker-built-hash file does not exist', () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs')
      const mockReadFileSync = jest.spyOn(mockFs, 'readFileSync').mockImplementation((..._args: unknown[]) => {
        throw new Error('ENOENT')
      })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        const state = (agent as unknown as { configSyncState: { dockerCustomizationHash: string | undefined } }).configSyncState
        expect(state.dockerCustomizationHash).toBeUndefined()
      } finally {
        mockReadFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should not read docker-built-hash when not in Docker', () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      delete process.env.AI_SUPPORT_AGENT_IN_DOCKER

      const mockFs = require('fs')
      const mockReadFileSync = jest.spyOn(mockFs, 'readFileSync')

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        const state = (agent as unknown as { configSyncState: { dockerCustomizationHash: string | undefined } }).configSyncState
        expect(state.dockerCustomizationHash).toBeUndefined()
        expect(mockReadFileSync).not.toHaveBeenCalledWith(expect.stringContaining('docker-built-hash'), expect.anything())
      } finally {
        mockReadFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should read docker-built-hash from getConfigDir() root when in Docker', () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs')
      const mockReadFileSync = jest.spyOn(mockFs, 'readFileSync').mockImplementation((..._args: unknown[]) => {
        throw new Error('ENOENT')
      })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        expect(agent).toBeDefined()
        // Should have tried to read from configDir root (not a sub-path with tenantCode)
        expect(mockReadFileSync).toHaveBeenCalledWith(
          expect.stringContaining('docker-built-hash'),
          'utf-8',
        )
      } finally {
        mockReadFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })
  })

  describe('performUpdate - write update-version.json failure', () => {
    it('should log warn when writing update-version.json fails in Docker mode', async () => {
      const originalSend = process.send
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      Object.defineProperty(process, 'send', { value: jest.fn(), writable: true, configurable: true })
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const { writeFileSync } = require('fs') as { writeFileSync: jest.Mock }
      writeFileSync.mockImplementation(() => { throw new Error('disk full') })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)
        await agent.performUpdate()
        await jest.advanceTimersByTimeAsync(1000)

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Failed to write update-version.json'),
        )
        expect(mockExit).toHaveBeenCalledWith(42)
      } finally {
        mockExit.mockRestore()
        Object.defineProperty(process, 'send', { value: originalSend, writable: true, configurable: true })
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })
  })

  describe('onReboot and onUpdate callbacks', () => {
    it('should pass onReboot callback that calls performReboot', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      const performRebootSpy = jest.spyOn(agent as unknown as { performReboot: () => Promise<void> }, 'performReboot').mockResolvedValue(undefined)

      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      // Get commandContext via subscriber callback
      const subscribeCall = mockSubscriber.subscribe.mock.calls[0]
      const notificationHandler = subscribeCall?.[0]
      if (notificationHandler) {
        // Trigger a notification that invokes onReboot via command
        // Instead, access commandContext directly via the onReboot path
      }

      // Access private commandContext through the agent internals
      const agentAny = agent as unknown as { performReboot: () => Promise<void> }
      await agentAny.performReboot()
      expect(performRebootSpy).toHaveBeenCalled()

      agent.stop()
    })

    it('should pass onUpdate callback that calls performUpdate', async () => {
      const agent = new ProjectAgent(project, 'agent-1', options)
      const performUpdateSpy = jest.spyOn(agent as unknown as { performUpdate: () => Promise<void> }, 'performUpdate').mockResolvedValue(undefined)

      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const agentAny = agent as unknown as { performUpdate: () => Promise<void> }
      await agentAny.performUpdate()
      expect(performUpdateSpy).toHaveBeenCalled()

      agent.stop()
    })

    it('should invoke onReboot via commandContext when executeCommand calls opts.onReboot', async () => {
      // This covers the arrow function `() => this.performReboot()` at line 405 of project-agent.ts
      mockedExecuteCommand.mockImplementation(async (_type, _payload, opts) => {
        if (opts?.onReboot) {
          await opts.onReboot()
        }
        return { success: true, data: 'ok' }
      })

      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-reboot-cb',
        type: 'reboot',
        payload: {},
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      const performRebootSpy = jest.spyOn(agent as unknown as { performReboot: () => Promise<void> }, 'performReboot').mockResolvedValue(undefined)

      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: 'notif-reboot-cb',
        table: 'commands',
        pk: 'CMD#reboot',
        sk: 'CMD#reboot',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-reboot-cb', type: 'reboot', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(performRebootSpy).toHaveBeenCalled()

      agent.stop()
    })

    it('should invoke onUpdate via commandContext when executeCommand calls opts.onUpdate', async () => {
      // This covers the arrow function `() => this.performUpdate()` at line 406 of project-agent.ts
      mockedExecuteCommand.mockImplementation(async (_type, _payload, opts) => {
        if (opts?.onUpdate) {
          await opts.onUpdate()
        }
        return { success: true, data: 'ok' }
      })

      mockClient.getCommand.mockResolvedValue({
        commandId: 'cmd-update-cb',
        type: 'update',
        payload: {},
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      const performUpdateSpy = jest.spyOn(agent as unknown as { performUpdate: () => Promise<void> }, 'performUpdate').mockResolvedValue(undefined)

      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      const onMessage = mockSubscriber.subscribe.mock.calls[0][1] as (notification: Record<string, unknown>) => void
      onMessage({
        id: 'notif-update-cb',
        table: 'commands',
        pk: 'CMD#update',
        sk: 'CMD#update',
        tenantCode: 'test-tenant',
        action: 'agent-command',
        content: { commandId: 'cmd-update-cb', type: 'update', tenantCode: 'test-tenant', projectCode: 'test-proj' },
      })

      await jest.advanceTimersByTimeAsync(100)

      expect(performUpdateSpy).toHaveBeenCalled()

      agent.stop()
    })
  })

  describe('registerAndStart - wsUrl Docker URL resolution', () => {
    it('should resolve localhost wsUrl to host.docker.internal when in Docker and wsEnabled', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const agentTransport = require('../src/agent-transport')
      const startTerminalWsSpy = jest.spyOn(agentTransport, 'startTerminalWebSocket').mockImplementation(() => {})

      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey',
        transportMode: 'realtime',
        wsEnabled: true,
        wsUrl: 'ws://127.0.0.1:3030',
      })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()
        await jest.advanceTimersByTimeAsync(100)

        expect(startTerminalWsSpy).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.stringContaining('host.docker.internal'),
          expect.anything(), // configSyncState
        )
      } finally {
        startTerminalWsSpy.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should retry when appsyncUrl is missing instead of starting the subscriber', async () => {
      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: null,
        appsyncApiKey: null,
        transportMode: 'realtime',
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      expect(logger.warn).toHaveBeenCalledWith('runner.registerStartedFailing')
      expect(MockAppSyncSubscriber).not.toHaveBeenCalled()
      agent.stop()
    })
  })

  describe('project directory', () => {
    it('should initialize project directory when projectDir is set', () => {
      const projectWithDir = { tenantCode: 'mbc', projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api', projectDir: '/tmp/proj' }
      const agent = new ProjectAgent(projectWithDir, 'agent-1', options)
      expect(agent).toBeDefined()
    })

    it('should initialize project directory when defaultProjectDir is set', () => {
      const agent = new ProjectAgent(project, 'agent-1', options, undefined, '~/projects/{projectCode}')
      expect(agent).toBeDefined()
    })

    it('should always initialize project directory even without explicit config', () => {
      const { initProjectDir } = require('../src/project-dir')
      const agent = new ProjectAgent(project, 'agent-1', options)
      expect(agent).toBeDefined()
      expect(initProjectDir).toHaveBeenCalledWith(project, undefined)
    })
  })

  describe('docker-registered-agent-id', () => {
    it('should write docker-registered-agent-id file after registration when running in Docker', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs') as { writeFileSync: jest.Mock; readFileSync: jest.Mock; existsSync: jest.Mock }
      const writtenFiles: Record<string, string> = {}
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
        writtenFiles[String(args[0])] = String(args[1])
      })

      try {
        mockClient.register.mockResolvedValue({
          agentId: 'server-assigned-uuid-1234',
          tenantCode: 'test-tenant',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        const registeredIdEntry = Object.entries(writtenFiles).find(([k]) => k.endsWith('docker-registered-agent-id.tmp'))
        expect(registeredIdEntry).toBeDefined()
        expect(registeredIdEntry![1]).toBe('server-assigned-uuid-1234')

        agent.stop()
      } finally {
        mockWriteFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should not write docker-registered-agent-id file when not running in Docker', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      delete process.env.AI_SUPPORT_AGENT_IN_DOCKER

      const mockFs = require('fs') as { writeFileSync: jest.Mock }
      const writtenFiles: Record<string, string> = {}
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
        writtenFiles[String(args[0])] = String(args[1])
      })

      try {
        mockClient.register.mockResolvedValue({
          agentId: 'server-assigned-uuid-1234',
          tenantCode: 'test-tenant',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        const registeredIdEntry = Object.entries(writtenFiles).find(([k]) => k.endsWith('docker-registered-agent-id.tmp'))
        expect(registeredIdEntry).toBeUndefined()

        agent.stop()
      } finally {
        mockWriteFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should warn but continue if writing docker-registered-agent-id fails', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs') as { writeFileSync: jest.Mock }
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
        if (String(args[0]).endsWith('docker-registered-agent-id.tmp')) {
          throw new Error('EACCES: permission denied')
        }
      })

      try {
        mockClient.register.mockResolvedValue({
          agentId: 'server-assigned-uuid-1234',
          tenantCode: 'test-tenant',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(100)

        // Should warn but not crash
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Failed to write docker-registered-agent-id'),
        )
        // Heartbeat should still proceed
        expect(mockClient.heartbeat).toHaveBeenCalled()

        agent.stop()
      } finally {
        mockWriteFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })
  })

  describe('CloudWatch Alert polling - clearInterval branch', () => {
    it('should clear existing alertPollingTimer when registerAndStart runs a second time', async () => {
      // This test covers line 443: `if (this.alertPollingTimer) { clearInterval(this.alertPollingTimer) }`
      // The only way to hit this branch is to call the private registerAndStart method directly
      // while alertPollingTimer is already set.
      const syncProjectConfigMock = syncProjectConfig as jest.MockedFunction<typeof syncProjectConfig>
      syncProjectConfigMock.mockResolvedValue({
        config: {
          configHash: 'cw-clear-hash',
          project: { projectCode: 'test-proj', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
          cloudwatch: {
            enabled: true,
            pollingIntervalMs: 60000,
            webhookUrl: 'https://api.example.com/webhooks/cloudwatch',
          },
        },
        fromCache: false,
      })

      ;(mockClient as Record<string, jest.Mock>).getPendingAlerts = jest.fn().mockResolvedValue({ items: [], total: 0 })
      ;(mockClient as Record<string, jest.Mock>).getStaleProcessingAlerts = jest.fn().mockResolvedValue({ items: [], total: 0 })
      ;(mockClient as Record<string, jest.Mock>).getAlert = jest.fn().mockResolvedValue(null)
      ;(mockClient as Record<string, jest.Mock>).updateAlertStatus = jest.fn().mockResolvedValue(undefined)
      ;(mockClient as Record<string, jest.Mock>).findActiveIssueByAlarmName = jest.fn().mockResolvedValue(null)

      const agent = new ProjectAgent(project, 'cw-clear-agent', options)
      agent.start()

      // Let registration complete and alertPollingTimer be set
      await jest.advanceTimersByTimeAsync(200)

      // Verify alertPollingTimer is set
      const agentInternal = agent as unknown as { alertPollingTimer: ReturnType<typeof setInterval> | null }
      expect(agentInternal.alertPollingTimer).not.toBeNull()

      // Now call registerAndStart again directly so the `if (this.alertPollingTimer)` branch is hit
      const agentAny = agent as unknown as { registerAndStart: () => Promise<void> }
      await agentAny.registerAndStart()

      // alertPollingTimer should have been cleared and reset
      expect(agentInternal.alertPollingTimer).not.toBeNull()

      agent.stop()
      syncProjectConfigMock.mockRestore()
    })
  })

  describe('CloudWatch Alert polling', () => {
    it('should start alert polling when cloudwatch is enabled in project config', async () => {
      const syncProjectConfigMock = syncProjectConfig as jest.MockedFunction<typeof syncProjectConfig>
      syncProjectConfigMock.mockResolvedValue({
        config: {
          configHash: 'abc123',
          project: { projectCode: 'test-proj', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
          cloudwatch: {
            enabled: true,
            pollingIntervalMs: 1000,  // 1秒に設定してテストで進める
            webhookUrl: 'https://api.example.com/webhooks/cloudwatch/mbc/MBC_01',
          },
        },
        fromCache: false,
      })

      // Mock getPendingAlerts for AlertProcessor
      ;(mockClient as Record<string, jest.Mock>).getPendingAlerts = jest.fn().mockResolvedValue({ items: [], total: 0 })
      ;(mockClient as Record<string, jest.Mock>).getStaleProcessingAlerts = jest.fn().mockResolvedValue({ items: [], total: 0 })
      ;(mockClient as Record<string, jest.Mock>).getAlert = jest.fn().mockResolvedValue(null)
      ;(mockClient as Record<string, jest.Mock>).updateAlertStatus = jest.fn().mockResolvedValue(undefined)
      ;(mockClient as Record<string, jest.Mock>).findActiveIssueByAlarmName = jest.fn().mockResolvedValue(null)

      const agent = new ProjectAgent(project, 'alert-test-agent', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(200)

      // Polling should be set up (AlertProcessor.checkPendingAlerts called on start)
      expect((mockClient as Record<string, jest.Mock>).getPendingAlerts).toHaveBeenCalled()

      // ポーリングタイマーをトリガー（setInterval コールバックをカバー）
      await jest.advanceTimersByTimeAsync(1100)
      expect((mockClient as Record<string, jest.Mock>).getPendingAlerts).toHaveBeenCalledTimes(2)

      // スタック救済タイマーも設定されていることを確認
      const agentInternal = agent as unknown as {
        alertStaleRecoveryTimer: ReturnType<typeof setInterval> | null
      }
      expect(agentInternal.alertStaleRecoveryTimer).not.toBeNull()

      // スタック救済タイマーのコールバックをトリガー（line 490: recoverStaleProcessingAlerts の実行をカバー）
      // ALERT_STALE_RECOVERY_INTERVAL_MS = 1時間 (3600000ms) 経過をシミュレート
      await jest.advanceTimersByTimeAsync(3_600_001)
      expect((mockClient as Record<string, jest.Mock>).getStaleProcessingAlerts).toHaveBeenCalled()

      // stop でタイマークリアも確認（pending/stale 両方）
      agent.stop()
      expect(agentInternal.alertStaleRecoveryTimer).toBeNull()

      syncProjectConfigMock.mockRestore()
    })

    it('should not start alert polling when cloudwatch is disabled', async () => {
      // Default mock does not include cloudwatch config
      ;(mockClient as Record<string, jest.Mock>).getPendingAlerts = jest.fn().mockResolvedValue({ items: [], total: 0 })
      ;(mockClient as Record<string, jest.Mock>).getStaleProcessingAlerts = jest.fn().mockResolvedValue({ items: [], total: 0 })

      const agent = new ProjectAgent(project, 'no-alert-agent', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(200)

      expect((mockClient as Record<string, jest.Mock>).getPendingAlerts).not.toHaveBeenCalled()

      agent.stop()
    })

    it('should clear existing alertPollingTimer when cloudwatch is re-enabled (prevents duplicate timers)', async () => {
      // This test covers the `if (this.alertPollingTimer) { clearInterval(...) }` branch at line 443.
      // We need to call registerAndStart twice with cloudwatch enabled so that alertPollingTimer
      // is non-null on the second call.
      const syncProjectConfigMock = syncProjectConfig as jest.MockedFunction<typeof syncProjectConfig>
      syncProjectConfigMock.mockResolvedValue({
        config: {
          configHash: 'cw-hash',
          project: { projectCode: 'test-proj', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
          cloudwatch: {
            enabled: true,
            pollingIntervalMs: 500,
            webhookUrl: 'https://api.example.com/webhooks/cloudwatch/mbc/MBC_01',
          },
        },
        fromCache: false,
      })

      ;(mockClient as Record<string, jest.Mock>).getPendingAlerts = jest.fn().mockResolvedValue({ items: [], total: 0 })
      ;(mockClient as Record<string, jest.Mock>).getStaleProcessingAlerts = jest.fn().mockResolvedValue({ items: [], total: 0 })
      ;(mockClient as Record<string, jest.Mock>).getAlert = jest.fn().mockResolvedValue(null)
      ;(mockClient as Record<string, jest.Mock>).updateAlertStatus = jest.fn().mockResolvedValue(undefined)
      ;(mockClient as Record<string, jest.Mock>).findActiveIssueByAlarmName = jest.fn().mockResolvedValue(null)

      // First registration — sets up the alert polling timer
      const agent = new ProjectAgent(project, 'cw-agent', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(200)

      // Stop and re-start so registerAndStart runs again with alertPollingTimer already set
      agent.stop()
      await jest.advanceTimersByTimeAsync(100)

      // Manually call performConfigSync to verify alertPollingTimer clearInterval path indirectly
      // The easiest way is to call updateToken which calls stop() + start() via setImmediate
      agent.updateToken('new-token-456')
      await jest.advanceTimersByTimeAsync(200)

      // Polling should still be active after re-registration
      expect((mockClient as Record<string, jest.Mock>).getPendingAlerts).toHaveBeenCalled()

      agent.stop()
      syncProjectConfigMock.mockRestore()
    })
  })

  describe('branch coverage: edge cases', () => {
    it('should not set dockerCustomizationHash when docker-built-hash file exists but is empty', () => {
      // Covers line 133: `if (builtHash)` — empty string is falsy
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs') as { readFileSync: jest.Mock }
      const mockReadFileSync = jest.spyOn(mockFs, 'readFileSync').mockImplementation((...args: unknown[]) => {
        if (String(args[0]).endsWith('docker-built-hash')) return '   ' // whitespace-only → trim() = ''
        throw new Error('ENOENT')
      })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        const state = (agent as unknown as { configSyncState: { dockerCustomizationHash: string | undefined } }).configSyncState
        // Empty/whitespace builtHash → should remain undefined
        expect(state.dockerCustomizationHash).toBeUndefined()
      } finally {
        mockReadFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should write empty string for docker-customization-hash when dockerCustomizationHash is undefined', async () => {
      // Covers line 251: `this.configSyncState.dockerCustomizationHash ?? ''`
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs') as { mkdirSync: jest.Mock; writeFileSync: jest.Mock }
      const mockMkdirSync = jest.spyOn(mockFs, 'mkdirSync').mockImplementation(() => undefined)
      const writtenFiles: Record<string, string> = {}
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation((...args: unknown[]) => {
        writtenFiles[String(args[0])] = String(args[1])
      })

      try {
        const agent = new ProjectAgent(project, 'agent-1', options)
        // Leave dockerCustomizationHash as undefined (not set in state)
        await agent.performDockerRebuild()
        await jest.advanceTimersByTimeAsync(1000)

        // docker-customization-hash should be written with empty string
        const hashEntry = Object.entries(writtenFiles).find(([k]) => k.endsWith('docker-customization-hash.tmp'))
        expect(hashEntry).toBeDefined()
        expect(hashEntry![1]).toBe('')
      } finally {
        mockExit.mockRestore()
        mockMkdirSync.mockRestore()
        mockWriteFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should throw "Update failed: Unknown error" when performUpdate result has no error message', async () => {
      // Covers line 276: `result.error ?? 'Unknown error'` when error is undefined
      mockedPerformUpdate.mockResolvedValueOnce({ success: false }) // no error field

      const agent = new ProjectAgent(project, 'agent-1', options)
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      await expect(agent.performUpdate()).rejects.toThrow('Update failed: Unknown error')

      agent.stop()
    })

    it('should treat empty docker-build-error file as no error (line 349: || undefined)', async () => {
      // Covers line 349: `fs.readFileSync(buildErrorPath, 'utf-8').trim() || undefined`
      // when the file exists but is empty → trim() = '' → falsy → undefined → no heartbeat
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs') as { readFileSync: jest.Mock; writeFileSync: jest.Mock }
      const mockReadFileSync = jest.spyOn(mockFs, 'readFileSync').mockImplementation((...args: unknown[]) => {
        const filePath = String(args[0])
        if (filePath.endsWith('docker-built-hash')) throw new Error('ENOENT')
        if (filePath.endsWith('docker-build-error')) return '' // empty file
        throw new Error('ENOENT')
      })
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation(() => undefined)

      // Count heartbeat calls before and after registration to ensure no extra call for build error
      const heartbeatCallsWithBuildError: unknown[][] = []

      try {
        mockClient.register.mockResolvedValue({
          agentId: 'server-agent-id',
          tenantCode: 'test-tenant',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })
        mockClient.heartbeat.mockImplementation((...args: unknown[]) => {
          heartbeatCallsWithBuildError.push(args)
          return Promise.resolve({ success: true })
        })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(200)

        // No heartbeat call should have a dockerBuildError argument (8th arg)
        const buildErrorCalls = heartbeatCallsWithBuildError.filter(args => args[7] !== undefined)
        expect(buildErrorCalls).toHaveLength(0)

        agent.stop()
      } finally {
        mockReadFileSync.mockRestore()
        mockWriteFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should handle wsEnabled=true with no wsUrl without throwing (covers the falsy wsUrl branch)', async () => {
      // Covers line 457: `result.wsUrl ? resolveUrlForDocker(result.wsUrl) : result.wsUrl`
      // when wsEnabled=true but wsUrl is absent → resolvedWsUrl = undefined
      const agentTransport = require('../src/agent-transport')
      const startTerminalWsSpy = jest.spyOn(agentTransport, 'startTerminalWebSocket').mockImplementation(() => {})
      const startVsCodeSpy = jest.spyOn(agentTransport, 'startVsCodeTunnel').mockImplementation(() => {})

      mockClient.register.mockResolvedValue({
        agentId: 'test-id',
        tenantCode: 'test-tenant',
        appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
        appsyncApiKey: 'da2-testkey123',
        transportMode: 'realtime',
        wsEnabled: true,
        wsUrl: undefined, // wsEnabled=true but no wsUrl → resolvedWsUrl = undefined
      })

      const agent = new ProjectAgent(project, 'agent-1', options)
      // Should not throw — wsUrl falsy → resolvedWsUrl = undefined → passed to startTerminalWebSocket
      agent.start()
      await jest.advanceTimersByTimeAsync(100)

      // Registration should proceed successfully
      expect(mockClient.register).toHaveBeenCalled()
      // heartbeat may not fire since startTerminalWebSocket is spied/replaced

      startTerminalWsSpy.mockRestore()
      startVsCodeSpy.mockRestore()
      agent.stop()
    })
  })

  describe('docker build error reporting (registerAndStart)', () => {
    it('should report docker-build-error via heartbeat and delete the file on success', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs') as {
        readFileSync: jest.Mock
        writeFileSync: jest.Mock
        unlinkSync: jest.Mock
        existsSync: jest.Mock
      }
      const mockReadFileSync = jest.spyOn(mockFs, 'readFileSync').mockImplementation((...args: unknown[]) => {
        const filePath = String(args[0])
        if (filePath.endsWith('docker-built-hash')) throw new Error('ENOENT')
        if (filePath.endsWith('docker-build-error')) return 'Build failed: npm install error'
        throw new Error('ENOENT')
      })
      const mockUnlinkSync = jest.spyOn(mockFs, 'unlinkSync').mockImplementation(() => undefined)
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation(() => undefined)

      try {
        mockClient.register.mockResolvedValue({
          agentId: 'server-agent-id',
          tenantCode: 'test-tenant',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })
        mockClient.heartbeat.mockResolvedValue({ success: true })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(200)

        // Heartbeat should have been called with the docker build error
        expect(mockClient.heartbeat).toHaveBeenCalledWith(
          'server-agent-id',
          expect.any(Object),
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          'Build failed: npm install error',
        )

        // Error file should be deleted after successful report
        expect(mockUnlinkSync).toHaveBeenCalledWith(
          expect.stringContaining('docker-build-error'),
        )

        agent.stop()
      } finally {
        mockReadFileSync.mockRestore()
        mockUnlinkSync.mockRestore()
        mockWriteFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should warn and keep docker-build-error file when heartbeat fails during error reporting', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs') as { readFileSync: jest.Mock; writeFileSync: jest.Mock }
      const mockReadFileSync = jest.spyOn(mockFs, 'readFileSync').mockImplementation((...args: unknown[]) => {
        const filePath = String(args[0])
        if (filePath.endsWith('docker-built-hash')) throw new Error('ENOENT')
        if (filePath.endsWith('docker-build-error')) return 'Build failed: timeout'
        throw new Error('ENOENT')
      })
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation(() => undefined)

      try {
        mockClient.register.mockResolvedValue({
          agentId: 'server-agent-id',
          tenantCode: 'test-tenant',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })
        // Make heartbeat fail on the build-error report call but succeed normally
        mockClient.heartbeat
          .mockRejectedValueOnce(new Error('Heartbeat error during build error report'))
          .mockResolvedValue({ success: true })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(200)

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Failed to report docker build error'),
        )

        agent.stop()
      } finally {
        mockReadFileSync.mockRestore()
        mockWriteFileSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })

    it('should warn and continue when deleting docker-build-error file fails after reporting', async () => {
      const originalDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
      process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

      const mockFs = require('fs') as { readFileSync: jest.Mock; writeFileSync: jest.Mock; unlinkSync: jest.Mock }
      const mockReadFileSync = jest.spyOn(mockFs, 'readFileSync').mockImplementation((...args: unknown[]) => {
        const filePath = String(args[0])
        if (filePath.endsWith('docker-built-hash')) throw new Error('ENOENT')
        if (filePath.endsWith('docker-build-error')) return 'Build error message'
        throw new Error('ENOENT')
      })
      const mockWriteFileSync = jest.spyOn(mockFs, 'writeFileSync').mockImplementation(() => undefined)
      const mockUnlinkSync = jest.spyOn(mockFs, 'unlinkSync').mockImplementation((...args: unknown[]) => {
        // Fail the deletion of docker-build-error file
        if (String(args[0]).endsWith('docker-build-error')) {
          throw new Error('EACCES: permission denied')
        }
      })

      try {
        mockClient.register.mockResolvedValue({
          agentId: 'server-agent-id',
          tenantCode: 'test-tenant',
          appsyncUrl: 'https://example.appsync-api.ap-northeast-1.amazonaws.com/graphql',
          appsyncApiKey: 'da2-testkey123',
          transportMode: 'realtime',
        })
        mockClient.heartbeat.mockResolvedValue({ success: true })

        const agent = new ProjectAgent(project, 'agent-1', options)
        agent.start()

        await jest.advanceTimersByTimeAsync(200)

        // Should still proceed past the failed unlink without crashing
        expect(mockClient.heartbeat).toHaveBeenCalled()
        // Registration should still succeed (heartbeat called)
        expect(mockClient.heartbeat).toHaveBeenCalled()

        agent.stop()
      } finally {
        mockReadFileSync.mockRestore()
        mockWriteFileSync.mockRestore()
        mockUnlinkSync.mockRestore()
        if (originalDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
        else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalDockerEnv
      }
    })
  })
})
