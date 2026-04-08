import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'

import { CHILD_PROCESS_MAX_RESTARTS, CHILD_PROCESS_RESTART_DELAY_MS, CHILD_PROCESS_STOP_TIMEOUT_MS } from '../src/constants'
import { ChildProcessManager } from '../src/child-process-manager'
import { logger } from '../src/logger'

jest.mock('../src/logger')

// Mock child_process.fork
const mockFork = jest.fn()
jest.mock('child_process', () => ({
  fork: (...args: unknown[]) => mockFork(...args),
}))

function createMockChild(connected = true): ChildProcess & EventEmitter {
  const emitter = new EventEmitter()
  const mock = emitter as unknown as ChildProcess & EventEmitter
  mock.send = jest.fn().mockReturnValue(true)
  mock.kill = jest.fn().mockReturnValue(true)
  Object.defineProperty(mock, 'connected', { value: connected, writable: true })
  Object.defineProperty(mock, 'pid', { value: Math.floor(Math.random() * 100000), writable: true })
  return mock
}

describe('ChildProcessManager', () => {
  let manager: ChildProcessManager

  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    manager = new ChildProcessManager()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const project = { tenantCode: 'mbc', projectCode: 'proj-a', token: 'tok-a', apiUrl: 'http://api-a' }
  const options = { pollInterval: 3000, heartbeatInterval: 60000 }

  describe('forkProject', () => {
    it('should fork a child process and send start message', () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      expect(mockFork).toHaveBeenCalledWith(
        expect.stringMatching(/project-worker\.(js|ts)$/),
        [],
        expect.objectContaining({ stdio: ['pipe', 'inherit', 'inherit', 'ipc'] }),
      )
      expect(mockChild.send).toHaveBeenCalledWith({
        type: 'start',
        project,
        agentId: 'agent-1',
        options,
      })
      expect(manager.getRunningCount()).toBe(1)
    })

    it('should log project started on started message', () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      mockChild.emit('message', { type: 'started', projectCode: 'proj-a' })

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('proj-a started'),
      )
    })

    it('should log error on error message from child', () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      mockChild.emit('message', { type: 'error', projectCode: 'proj-a', message: 'boom' })

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('boom'),
      )
    })

    it('should log stopped on stopped message from child', () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      mockChild.emit('message', { type: 'stopped', projectCode: 'proj-a' })

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('proj-a stopped'),
      )
    })

    it('should ignore non-IPC messages', () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      // Should not throw
      mockChild.emit('message', 'not-an-ipc-message')
      mockChild.emit('message', { type: 'unknown' })
    })
  })

  describe('child exit and restart', () => {
    it('should restart child on unexpected exit', () => {
      const mockChild1 = createMockChild()
      const mockChild2 = createMockChild()
      mockFork.mockReturnValueOnce(mockChild1).mockReturnValueOnce(mockChild2)

      manager.forkProject(project, 'agent-1', options)

      // Simulate unexpected exit
      mockChild1.emit('exit', 1, null)

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('proj-a exited'),
      )

      // Advance past restart delay
      jest.advanceTimersByTime(CHILD_PROCESS_RESTART_DELAY_MS)

      expect(mockFork).toHaveBeenCalledTimes(2)
      expect(mockChild2.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'start' }),
      )
    })

    it('should stop restarting after max restarts', () => {
      const children: (ChildProcess & EventEmitter)[] = []
      for (let i = 0; i <= CHILD_PROCESS_MAX_RESTARTS; i++) {
        children.push(createMockChild())
      }
      let callIndex = 0
      mockFork.mockImplementation(() => children[callIndex++])

      manager.forkProject(project, 'agent-1', options)

      // Exhaust all restarts
      for (let i = 0; i < CHILD_PROCESS_MAX_RESTARTS; i++) {
        children[i].emit('exit', 1, null)
        jest.advanceTimersByTime(CHILD_PROCESS_RESTART_DELAY_MS)
      }

      // Next exit should not restart
      children[CHILD_PROCESS_MAX_RESTARTS].emit('exit', 1, null)
      jest.advanceTimersByTime(CHILD_PROCESS_RESTART_DELAY_MS)

      // 1 initial + MAX_RESTARTS restarts = MAX_RESTARTS + 1 forks total
      expect(mockFork).toHaveBeenCalledTimes(CHILD_PROCESS_MAX_RESTARTS + 1)
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('exceeded max restarts'),
      )
    })

    it('should reset restart count on successful start', () => {
      const children: (ChildProcess & EventEmitter)[] = []
      for (let i = 0; i < 4; i++) {
        children.push(createMockChild())
      }
      let callIndex = 0
      mockFork.mockImplementation(() => children[callIndex++])

      manager.forkProject(project, 'agent-1', options)

      // Crash and restart 3 times
      for (let i = 0; i < 3; i++) {
        children[i].emit('exit', 1, null)
        jest.advanceTimersByTime(CHILD_PROCESS_RESTART_DELAY_MS)
      }

      // Child sends started -> counter should reset
      children[3].emit('message', { type: 'started', projectCode: 'proj-a' })

      // Now it should be able to restart again from 0
      const child5 = createMockChild()
      mockFork.mockReturnValueOnce(child5)
      children[3].emit('exit', 1, null)
      jest.advanceTimersByTime(CHILD_PROCESS_RESTART_DELAY_MS)

      // Should have forked again (restart counter was reset)
      expect(mockFork).toHaveBeenCalledTimes(5)
    })

    it('should not restart when stopping', async () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      // Start stopping
      const stopPromise = manager.stopAll(1000)
      mockChild.emit('exit', 0, null)
      await stopPromise

      // Should not try to restart
      jest.advanceTimersByTime(CHILD_PROCESS_STOP_TIMEOUT_MS)
      expect(mockFork).toHaveBeenCalledTimes(1)
    })

    it('should cancel pending restart timers on stopAll', async () => {
      const child1 = createMockChild()
      mockFork.mockReturnValueOnce(child1)

      manager.forkProject(project, 'agent-1', options)

      // Simulate unexpected exit, starting restart delay
      child1.emit('exit', 1, null)

      // stopAll should cancel the pending restart timer
      const stopPromise = manager.stopAll(100)
      jest.advanceTimersByTime(100)
      await stopPromise

      // Advance past restart delay — should NOT fork a new child
      jest.advanceTimersByTime(CHILD_PROCESS_RESTART_DELAY_MS)
      expect(mockFork).toHaveBeenCalledTimes(1)
    })

    it('should not restart when stopping flag is set during restart delay', async () => {
      const child1 = createMockChild()
      mockFork.mockReturnValueOnce(child1)

      manager.forkProject(project, 'agent-1', options)

      // Simulate unexpected exit, starting restart delay
      child1.emit('exit', 1, null)

      // Set stopping before restart delay fires
      const stopPromise = manager.stopAll(100)

      // The exit event from stopAll resolves immediately since child already exited
      // Advance past both stop timeout and restart delay
      jest.advanceTimersByTime(CHILD_PROCESS_RESTART_DELAY_MS)
      await stopPromise

      // Should not have forked a second child
      expect(mockFork).toHaveBeenCalledTimes(1)
    })
  })

  describe('sendTokenUpdate', () => {
    it('should send token_update message to the correct child process', () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)
      manager.sendTokenUpdate('proj-a', 'new-token')

      expect(mockChild.send).toHaveBeenCalledWith({
        type: 'token_update',
        token: 'new-token',
      })
    })

    it('should update stored token for restarts', () => {
      const child1 = createMockChild()
      const child2 = createMockChild()
      mockFork.mockReturnValueOnce(child1).mockReturnValueOnce(child2)

      manager.forkProject(project, 'agent-1', options)
      manager.sendTokenUpdate('proj-a', 'new-token')

      // Simulate crash and restart
      child1.emit('exit', 1, null)
      jest.advanceTimersByTime(CHILD_PROCESS_RESTART_DELAY_MS)

      // The restarted child should receive start message with the new token
      expect(child2.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'start',
          project: expect.objectContaining({ token: 'new-token' }),
        }),
      )
    })

    it('should not throw for unknown project code', () => {
      expect(() => manager.sendTokenUpdate('unknown-proj', 'new-token')).not.toThrow()
    })

    it('should skip disconnected child process', () => {
      const mockChild = createMockChild(false)
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)
      manager.sendTokenUpdate('proj-a', 'new-token')

      // send was called once for start only, not for token_update
      expect(mockChild.send).toHaveBeenCalledTimes(1)
    })
  })

  describe('sendUpdateToAll', () => {
    it('should send update message to all connected children', () => {
      const child1 = createMockChild()
      const child2 = createMockChild()
      mockFork.mockReturnValueOnce(child1).mockReturnValueOnce(child2)

      const project2 = { tenantCode: 'mbc', projectCode: 'proj-b', token: 'tok-b', apiUrl: 'http://api-b' }

      manager.forkProject(project, 'agent-1', options)
      manager.forkProject(project2, 'agent-1', options)

      manager.sendUpdateToAll()

      expect(child1.send).toHaveBeenCalledWith({ type: 'update' })
      expect(child2.send).toHaveBeenCalledWith({ type: 'update' })
    })

    it('should skip disconnected children', () => {
      const mockChild = createMockChild(false)
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      manager.sendUpdateToAll()

      // send was called once for start, but not again for update
      expect(mockChild.send).toHaveBeenCalledTimes(1)
    })
  })

  describe('stopAll', () => {
    it('should send shutdown to all children and wait for exit', async () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      const stopPromise = manager.stopAll(5000)

      // Simulate child exiting
      mockChild.emit('exit', 0, null)

      await stopPromise

      expect(mockChild.send).toHaveBeenCalledWith({ type: 'shutdown' })
      expect(manager.getRunningCount()).toBe(0)
    })

    it('should SIGKILL children that do not exit within timeout', async () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      const stopPromise = manager.stopAll(1000)

      // Do not emit exit - let timeout trigger
      jest.advanceTimersByTime(1000)

      await stopPromise

      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL')
      expect(manager.getRunningCount()).toBe(0)
    })

    it('should handle disconnected children', async () => {
      const mockChild = createMockChild(false)
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      const stopPromise = manager.stopAll(1000)

      // Trigger timeout
      jest.advanceTimersByTime(1000)

      await stopPromise

      // Should not have sent shutdown (disconnected), but should still SIGKILL
      expect(mockChild.send).toHaveBeenCalledTimes(1) // only the initial start
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL')
    })
  })

  describe('stopAll with default timeout', () => {
    it('should use default timeout when no argument is provided', async () => {
      const mockChild = createMockChild()
      mockFork.mockReturnValue(mockChild)

      manager.forkProject(project, 'agent-1', options)

      const stopPromise = manager.stopAll()

      // Default timeout
      jest.advanceTimersByTime(CHILD_PROCESS_STOP_TIMEOUT_MS)

      await stopPromise

      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL')
    })
  })

  describe('getRunningCount', () => {
    it('should return 0 when no processes', () => {
      expect(manager.getRunningCount()).toBe(0)
    })

    it('should return correct count', () => {
      const child1 = createMockChild()
      const child2 = createMockChild()
      mockFork.mockReturnValueOnce(child1).mockReturnValueOnce(child2)

      manager.forkProject(project, 'agent-1', options)
      manager.forkProject(
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'tok-b', apiUrl: 'http://api-b' },
        'agent-1',
        options,
      )

      expect(manager.getRunningCount()).toBe(2)
    })
  })
})
