import type { IpcStartMessage } from '../src/ipc-types'
import { logger } from '../src/logger'

jest.mock('../src/logger')
jest.mock('../src/sentry', () => ({
  initSentry: jest.fn().mockResolvedValue(undefined),
  captureException: jest.fn(),
  flushSentry: jest.fn().mockResolvedValue(undefined),
}))

// Mock ProjectAgent
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockShutdown = jest.fn().mockResolvedValue(undefined)
const mockGetClient = jest.fn()
const mockUpdateToken = jest.fn()
const mockIsBusy = jest.fn().mockReturnValue(false)
jest.mock('../src/project-agent', () => ({
  ProjectAgent: jest.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    shutdown: mockShutdown,
    getClient: mockGetClient,
    updateToken: mockUpdateToken,
    isBusy: mockIsBusy,
    project: { projectCode: 'test-proj' },
  })),
}))

jest.mock('../src/chat-mode-detector', () => ({
  ...jest.requireActual('../src/chat-mode-detector'),
  detectAvailableChatModes: jest.fn().mockResolvedValue([]),
  resolveActiveChatMode: jest.fn().mockReturnValue(undefined),
}))
jest.mock('../src/appsync-subscriber', () => ({
  AppSyncSubscriber: jest.fn(),
}))
jest.mock('../src/project-dir', () => ({
  initProjectDir: jest.fn().mockReturnValue('/tmp/test-project'),
}))
jest.mock('../src/project-config-sync', () => ({
  syncProjectConfig: jest.fn().mockResolvedValue({
    config: {
      configHash: 'hash',
      project: { projectCode: 'test-proj', projectName: 'Test' },
      agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
    },
    fromCache: false,
  }),
}))
jest.mock('../src/aws-profile', () => ({
  writeAwsConfig: jest.fn(),
}))

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

describe('project-worker', () => {
  const processListeners = new Map<string, Function[]>()
  let exitSpy: jest.SpiedFunction<typeof process.exit>
  let processSendSpy: jest.Mock

  beforeEach(() => {
    jest.clearAllMocks()
    processListeners.clear()

    // Spy on process.on to capture handlers
    jest.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      const listeners = processListeners.get(event) ?? []
      listeners.push(handler)
      processListeners.set(event, listeners)
      return process
    }) as typeof process.on)

    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    // Mock process.send
    processSendSpy = jest.fn()
    Object.defineProperty(process, 'send', { value: processSendSpy, writable: true, configurable: true })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    Object.defineProperty(process, 'send', { value: undefined, writable: true, configurable: true })
  })

  function loadWorker(): { startWorker: () => void } {
    // Use isolateModules so we get a fresh module each time
    let workerModule: { startWorker: () => void }
    jest.isolateModules(() => {
      workerModule = require('../src/project-worker')
    })
    return workerModule!
  }

  function emitProcessEvent(event: string, ...args: unknown[]): void {
    const listeners = processListeners.get(event) ?? []
    for (const listener of listeners) {
      listener(...args)
    }
  }

  const startMessage: IpcStartMessage = {
    type: 'start',
    project: { tenantCode: 'mbc', projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api' },
    agentId: 'agent-1',
    options: { pollInterval: 3000, heartbeatInterval: 60000 },
  }

  describe('startWorker', () => {
    it('should register message, disconnect, and error handlers', () => {
      const worker = loadWorker()
      worker.startWorker()

      expect(processListeners.has('message')).toBe(true)
      expect(processListeners.has('disconnect')).toBe(true)
      expect(processListeners.has('uncaughtException')).toBe(true)
      expect(processListeners.has('unhandledRejection')).toBe(true)
    })
  })

  describe('message handler', () => {
    it('should handle start message and send started response', async () => {
      const { ProjectAgent } = require('../src/project-agent')

      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', startMessage)

      // Wait for async handleStart
      await flushAsync()

      expect(ProjectAgent).toHaveBeenCalledWith(
        startMessage.project,
        'agent-1',
        startMessage.options,
        undefined,
        undefined,
        expect.any(Function),
      )
      expect(mockStart).toHaveBeenCalled()
      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'started',
        tenantCode: 'mbc',
        projectCode: 'test-proj',
      })
    })

    it('should forward a permanent auth rejection from ProjectAgent to the parent as an auth_rejected IPC message', async () => {
      const { ProjectAgent } = require('../src/project-agent')

      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', startMessage)
      await flushAsync()

      // The 6th constructor arg is the onAuthRejected callback wired to send IPC.
      const onAuthRejected = (ProjectAgent as jest.Mock).mock.calls[0][5] as (transport: string) => void
      expect(typeof onAuthRejected).toBe('function')

      onAuthRejected('terminal')

      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'auth_rejected',
        tenantCode: 'mbc',
        projectCode: 'test-proj',
        transport: 'terminal',
      })
    })

    it('should enable verbose logging when options.verbose is true', async () => {
      const worker = loadWorker()
      worker.startWorker()

      const verboseStartMessage: IpcStartMessage = {
        ...startMessage,
        options: { ...startMessage.options, verbose: true },
      }

      emitProcessEvent('message', verboseStartMessage)
      await flushAsync()

      expect((logger.setVerbose as jest.Mock)).toHaveBeenCalledWith(true)
    })

    it('should handle shutdown message by awaiting the graceful drain (agent.shutdown), not the synchronous stop', async () => {
      const worker = loadWorker()
      worker.startWorker()

      // First start an agent
      emitProcessEvent('message', startMessage)
      await flushAsync()

      // Then shutdown, with an explicit drain budget from the parent
      emitProcessEvent('message', { type: 'shutdown', drainTimeoutMs: 6000 })
      await flushAsync()

      expect(mockShutdown).toHaveBeenCalledWith({ drainTimeoutMs: 6000 })
      expect(mockStop).not.toHaveBeenCalled()
      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'stopped',
        tenantCode: 'mbc',
        projectCode: 'test-proj',
      })
      expect(exitSpy).toHaveBeenCalledWith(0)
    })

    it('falls back to FORK_SHUTDOWN_DRAIN_TIMEOUT_MS when the shutdown message carries no drainTimeoutMs', async () => {
      const { FORK_SHUTDOWN_DRAIN_TIMEOUT_MS } = require('../src/constants')
      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', startMessage)
      await flushAsync()

      emitProcessEvent('message', { type: 'shutdown' })
      await flushAsync()

      expect(mockShutdown).toHaveBeenCalledWith({ drainTimeoutMs: FORK_SHUTDOWN_DRAIN_TIMEOUT_MS })
    })

    it('should handle update message by awaiting the graceful drain (agent.shutdown)', async () => {
      const worker = loadWorker()
      worker.startWorker()

      // First start an agent
      emitProcessEvent('message', startMessage)
      await flushAsync()

      // Then update
      emitProcessEvent('message', { type: 'update' })
      await flushAsync()

      expect(mockShutdown).toHaveBeenCalled()
      expect(mockStop).not.toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalledWith(0)
    })

    it('falls back to the (now larger, SHUTDOWN_DRAIN_TIMEOUT_MS-sized) FORK_SHUTDOWN_DRAIN_TIMEOUT_MS for the update message, which never carries an explicit drainTimeoutMs', async () => {
      const { FORK_SHUTDOWN_DRAIN_TIMEOUT_MS } = require('../src/constants')
      expect(FORK_SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(300_000)

      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', startMessage)
      await flushAsync()

      emitProcessEvent('message', { type: 'update' })
      await flushAsync()

      expect(mockShutdown).toHaveBeenCalledWith({ drainTimeoutMs: FORK_SHUTDOWN_DRAIN_TIMEOUT_MS })
    })

    it('should send error message when start fails', async () => {
      const { ProjectAgent } = require('../src/project-agent')
      ProjectAgent.mockImplementationOnce(() => {
        throw new Error('init failed')
      })

      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', startMessage)
      await flushAsync()

      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'error',
        tenantCode: 'mbc',
        projectCode: 'test-proj',
        message: 'init failed',
      })
    })

    it('should wrap non-Error thrown value in new Error when start fails', async () => {
      const { ProjectAgent } = require('../src/project-agent')
      // Throw a non-Error value (string) to cover the `err instanceof Error ? err : new Error(String(err))` false branch
      ProjectAgent.mockImplementationOnce(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'string error value'
      })

      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', startMessage)
      await flushAsync()

      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'error',
        tenantCode: 'mbc',
        projectCode: 'test-proj',
        message: 'string error value',
      })
    })

    it('should handle token_update message', async () => {
      const worker = loadWorker()
      worker.startWorker()

      // First start an agent
      emitProcessEvent('message', startMessage)
      await flushAsync()

      // Then send token_update
      emitProcessEvent('message', { type: 'token_update', token: 'new-token-123' })
      await flushAsync()

      expect(mockUpdateToken).toHaveBeenCalledWith('new-token-123')
    })

    it('should ignore token_update when agent is not started', () => {
      const worker = loadWorker()
      worker.startWorker()

      // Send token_update without starting agent first
      emitProcessEvent('message', { type: 'token_update', token: 'new-token' })

      // Should not throw
      expect(mockUpdateToken).not.toHaveBeenCalled()
    })

    it('should handle busy_query message and respond with busy_response', async () => {
      const worker = loadWorker()
      worker.startWorker()

      // Start agent first
      emitProcessEvent('message', startMessage)
      await flushAsync()

      processSendSpy.mockClear()

      // Agent is not busy
      mockIsBusy.mockReturnValue(false)
      emitProcessEvent('message', { type: 'busy_query' })

      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'busy_response',
        tenantCode: 'mbc',
        projectCode: 'test-proj',
        busy: false,
      })
    })

    it('should respond busy=true when agent is processing', async () => {
      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', startMessage)
      await flushAsync()

      processSendSpy.mockClear()

      mockIsBusy.mockReturnValue(true)
      emitProcessEvent('message', { type: 'busy_query' })

      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'busy_response',
        tenantCode: 'mbc',
        projectCode: 'test-proj',
        busy: true,
      })
    })

    it('should respond busy=false when agent is not started', () => {
      const worker = loadWorker()
      worker.startWorker()

      // No agent started, send busy_query
      emitProcessEvent('message', { type: 'busy_query' })

      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'busy_response',
        tenantCode: 'unknown',
        projectCode: 'unknown',
        busy: false,
      })
    })

    it('should ignore non-IPC messages', () => {
      const worker = loadWorker()
      worker.startWorker()

      // Should not throw
      emitProcessEvent('message', 'not-an-ipc-message')
      emitProcessEvent('message', { type: 'unknown' })
    })

    it('should handle shutdown before start (unknown projectCode)', async () => {
      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', { type: 'shutdown' })
      await flushAsync()

      expect(exitSpy).toHaveBeenCalledWith(0)
    })

    it('should handle update before start (unknown projectCode)', async () => {
      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', { type: 'update' })
      await flushAsync()

      expect(exitSpy).toHaveBeenCalledWith(0)
    })
  })

  describe('disconnect handler', () => {
    // The parent's IPC channel being gone does not affect this worker's
    // ability to drain in-flight commands or release its replica slot: both
    // go straight from this worker process to the backend API
    // (ApiClient.releaseSelf() / the worker's own AppSync subscription),
    // independent of the parent. So the disconnect path must use the same
    // drained shutdown() as the graceful (`shutdown`/`update` IPC message)
    // path, not the old synchronous stop() — only the exit code (1, abnormal
    // termination) stays different.
    it('should gracefully shut down (drain) the agent, not just stop() it, and exit with 1 on parent disconnect', async () => {
      const { FORK_SHUTDOWN_DRAIN_TIMEOUT_MS } = require('../src/constants')
      const worker = loadWorker()
      worker.startWorker()

      // Start agent first
      emitProcessEvent('message', startMessage)
      await flushAsync()

      emitProcessEvent('disconnect')
      // process.on('disconnect', ...) is not itself awaited by Node; the
      // handler dispatches the async shutdown via `void`, so give its promise
      // chain a chance to resolve before asserting on it.
      await flushAsync()

      expect(mockStop).not.toHaveBeenCalled()
      expect(mockShutdown).toHaveBeenCalledWith({ drainTimeoutMs: FORK_SHUTDOWN_DRAIN_TIMEOUT_MS })
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('flushes Sentry before exiting, matching handleGracefulExit (regression: this path used to exit without flushing, silently dropping any captured Sentry event)', async () => {
      const { flushSentry } = require('../src/sentry')
      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', startMessage)
      await flushAsync()

      expect(flushSentry).not.toHaveBeenCalled()

      emitProcessEvent('disconnect')
      await flushAsync()

      expect(flushSentry).toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('exits with 1 even though the graceful (shutdown/update) IPC path exits with 0, to preserve abnormal-termination exit code semantics', async () => {
      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('message', startMessage)
      await flushAsync()

      emitProcessEvent('disconnect')
      await flushAsync()

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(exitSpy).not.toHaveBeenCalledWith(0)
    })
  })

  describe('error handlers', () => {
    it('should handle uncaughtException', async () => {
      const { captureException, flushSentry } = require('../src/sentry')
      const worker = loadWorker()
      worker.startWorker()

      const error = new Error('test uncaught')
      emitProcessEvent('uncaughtException', error)

      await flushAsync()

      expect(captureException).toHaveBeenCalledWith(error, { handler: 'worker:uncaughtException' })
      expect(flushSentry).toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('should handle unhandledRejection', () => {
      const { captureException } = require('../src/sentry')
      const worker = loadWorker()
      worker.startWorker()

      emitProcessEvent('unhandledRejection', 'rejected reason')

      expect(captureException).toHaveBeenCalledWith('rejected reason', { handler: 'worker:unhandledRejection' })
    })
  })

  describe('sendToParent', () => {
    it('should not throw when process.send is undefined', async () => {
      Object.defineProperty(process, 'send', { value: undefined, writable: true, configurable: true })

      const worker = loadWorker()
      worker.startWorker()

      // Should not throw even when process.send is undefined
      emitProcessEvent('message', startMessage)
      await flushAsync()

      // No error should have been thrown
    })
  })
})
