import { ChildProcessManager } from '../src/child-process-manager'

jest.mock('child_process', () => ({
  fork: jest.fn().mockImplementation(() => {
    const handlers: Record<string, Function[]> = {}
    const child = {
      pid: Math.floor(Math.random() * 10000),
      connected: true,
      send: jest.fn(),
      kill: jest.fn(),
      on: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (!handlers[event]) handlers[event] = []
        handlers[event].push(handler)
      }),
      once: jest.fn().mockImplementation((event: string, handler: Function) => {
        if (!handlers[event]) handlers[event] = []
        handlers[event].push(handler)
      }),
      // Helper to emit events in tests
      _emit: (event: string, ...args: unknown[]) => {
        for (const h of handlers[event] ?? []) h(...args)
      },
    }
    return child
  }),
}))
jest.mock('../src/logger')

const { fork } = require('child_process') as { fork: jest.Mock }

describe('ChildProcessManager', () => {
  let manager: ChildProcessManager

  beforeEach(() => {
    jest.clearAllMocks()
    manager = new ChildProcessManager()
  })

  const project = { projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api' }
  const options = { pollInterval: 3000, heartbeatInterval: 30000 }

  describe('forkProject', () => {
    it('should fork a child process and send start message', () => {
      manager.forkProject(project, 'agent-1', options)

      expect(fork).toHaveBeenCalledTimes(1)
      const child = fork.mock.results[0].value
      expect(child.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'start',
          project,
          agentId: 'agent-1',
        }),
      )
    })
  })

  describe('hasProject', () => {
    it('should return true for forked project', () => {
      manager.forkProject(project, 'agent-1', options)
      expect(manager.hasProject('proj-a')).toBe(true)
    })

    it('should return false for unknown project', () => {
      expect(manager.hasProject('proj-unknown')).toBe(false)
    })
  })

  describe('stopProject', () => {
    it('should send shutdown and remove project after exit', async () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value

      expect(manager.hasProject('proj-a')).toBe(true)

      const stopPromise = manager.stopProject('proj-a')

      expect(child.send).toHaveBeenCalledWith({ type: 'shutdown' })

      // Simulate child exit
      child._emit('exit', 0, null)

      await stopPromise

      expect(manager.hasProject('proj-a')).toBe(false)
    })

    it('should do nothing for unknown project', async () => {
      await manager.stopProject('proj-unknown')
      // Should not throw
    })

    it('should force kill if child does not exit within timeout', async () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value

      jest.useFakeTimers()

      const stopPromise = manager.stopProject('proj-a', 100)

      // Don't emit exit — let it timeout
      jest.advanceTimersByTime(200)

      await stopPromise

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(manager.hasProject('proj-a')).toBe(false)

      jest.useRealTimers()
    })
  })

  describe('sendTokenUpdate', () => {
    it('should send token_update to connected child', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value

      manager.sendTokenUpdate('proj-a', 'new-token')

      expect(child.send).toHaveBeenCalledWith({ type: 'token_update', token: 'new-token' })
    })

    it('should do nothing for unknown project', () => {
      manager.sendTokenUpdate('proj-unknown', 'new-token')
      // Should not throw
    })
  })

  describe('getRunningCount', () => {
    it('should return the number of forked projects', () => {
      expect(manager.getRunningCount()).toBe(0)

      manager.forkProject(project, 'agent-1', options)
      expect(manager.getRunningCount()).toBe(1)

      manager.forkProject(
        { projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
        'agent-1',
        options,
      )
      expect(manager.getRunningCount()).toBe(2)
    })
  })

  describe('isAnyBusy', () => {
    it('should return false when no processes are running', async () => {
      const result = await manager.isAnyBusy()
      expect(result).toBe(false)
    })

    it('should return false when all children report not busy', async () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value

      // Simulate child responding to busy_query
      child.send.mockImplementation((msg: { type: string }) => {
        if (msg.type === 'busy_query') {
          // Trigger the message handler with busy_response
          child._emit('message', { type: 'busy_response', projectCode: 'proj-a', busy: false })
        }
      })

      const result = await manager.isAnyBusy()
      expect(result).toBe(false)
    })

    it('should return true when any child reports busy', async () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value

      child.send.mockImplementation((msg: { type: string }) => {
        if (msg.type === 'busy_query') {
          child._emit('message', { type: 'busy_response', projectCode: 'proj-a', busy: true })
        }
      })

      const result = await manager.isAnyBusy()
      expect(result).toBe(true)
    })

    it('should return false on timeout when child does not respond', async () => {
      manager.forkProject(project, 'agent-1', options)
      // Don't respond to busy_query — let it timeout

      jest.useFakeTimers()
      const busyPromise = manager.isAnyBusy(100)
      jest.advanceTimersByTime(200)
      const result = await busyPromise
      expect(result).toBe(false)
      jest.useRealTimers()
    })

    it('should handle multiple children with mixed busy states', async () => {
      manager.forkProject(project, 'agent-1', options)
      manager.forkProject(
        { projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
        'agent-1',
        options,
      )

      const children = fork.mock.results.map((r: { value: unknown }) => r.value) as any[]

      // proj-a is not busy, proj-b is busy
      children[0].send.mockImplementation((msg: { type: string }) => {
        if (msg.type === 'busy_query') {
          children[0]._emit('message', { type: 'busy_response', projectCode: 'proj-a', busy: false })
        }
      })
      children[1].send.mockImplementation((msg: { type: string }) => {
        if (msg.type === 'busy_query') {
          children[1]._emit('message', { type: 'busy_response', projectCode: 'proj-b', busy: true })
        }
      })

      const result = await manager.isAnyBusy()
      expect(result).toBe(true)
    })

    it('should skip disconnected children', async () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value
      child.connected = false

      const result = await manager.isAnyBusy()
      expect(result).toBe(false)
    })
  })

  describe('update_complete message', () => {
    it('should call onUpdateComplete when worker sends update_complete', () => {
      const onUpdateComplete = jest.fn()
      manager.onUpdateComplete = onUpdateComplete

      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      child._emit('message', { type: 'update_complete', projectCode: 'proj-a' })

      expect(onUpdateComplete).toHaveBeenCalled()
    })

    it('should not throw when onUpdateComplete is not set', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      expect(() => {
        child._emit('message', { type: 'update_complete', projectCode: 'proj-a' })
      }).not.toThrow()
    })
  })

  describe('stopAll', () => {
    it('should send shutdown to all children and wait for exit', async () => {
      manager.forkProject(project, 'agent-1', options)
      manager.forkProject(
        { projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
        'agent-1',
        options,
      )

      const children = fork.mock.results.map((r: { value: unknown }) => r.value) as Array<ReturnType<typeof fork>>

      const stopPromise = manager.stopAll()

      // Simulate both children exiting
      for (const child of children) {
        ;(child as any)._emit('exit', 0, null)
      }

      await stopPromise

      expect(manager.getRunningCount()).toBe(0)
    })
  })
})
