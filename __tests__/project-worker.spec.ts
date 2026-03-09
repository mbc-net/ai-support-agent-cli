import type { IpcStartMessage } from '../src/ipc-types'

jest.mock('../src/logger')
jest.mock('../src/sentry', () => ({
  initSentry: jest.fn().mockResolvedValue(undefined),
  captureException: jest.fn(),
  flushSentry: jest.fn().mockResolvedValue(undefined),
}))

// Mock ProjectAgent
const mockStart = jest.fn()
const mockStop = jest.fn()
const mockGetClient = jest.fn()
const mockUpdateToken = jest.fn()
jest.mock('../src/project-agent', () => ({
  ProjectAgent: jest.fn().mockImplementation(() => ({
    start: mockStart,
    stop: mockStop,
    getClient: mockGetClient,
    updateToken: mockUpdateToken,
    project: { projectCode: 'test-proj' },
  })),
}))

jest.mock('../src/chat-mode-detector', () => ({
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
    configHash: 'hash',
    project: { projectCode: 'test-proj', projectName: 'Test' },
    agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
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
    project: { projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api' },
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
      )
      expect(mockStart).toHaveBeenCalled()
      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'started',
        projectCode: 'test-proj',
      })
    })

    it('should handle shutdown message', async () => {
      const worker = loadWorker()
      worker.startWorker()

      // First start an agent
      emitProcessEvent('message', startMessage)
      await flushAsync()

      // Then shutdown
      emitProcessEvent('message', { type: 'shutdown' })
      await flushAsync()

      expect(mockStop).toHaveBeenCalled()
      expect(processSendSpy).toHaveBeenCalledWith({
        type: 'stopped',
        projectCode: 'test-proj',
      })
      expect(exitSpy).toHaveBeenCalledWith(0)
    })

    it('should handle update message', async () => {
      const worker = loadWorker()
      worker.startWorker()

      // First start an agent
      emitProcessEvent('message', startMessage)
      await flushAsync()

      // Then update
      emitProcessEvent('message', { type: 'update' })
      await flushAsync()

      expect(mockStop).toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalledWith(0)
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
        projectCode: 'test-proj',
        message: 'init failed',
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
    it('should stop agent and exit on disconnect', async () => {
      const worker = loadWorker()
      worker.startWorker()

      // Start agent first
      emitProcessEvent('message', startMessage)
      await flushAsync()

      emitProcessEvent('disconnect')

      expect(mockStop).toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalledWith(1)
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
