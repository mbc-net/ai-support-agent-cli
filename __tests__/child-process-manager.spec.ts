import { ChildProcessManager } from '../src/child-process-manager'
import { CHILD_PROCESS_MAX_RESTARTS } from '../src/constants'

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
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
}))
jest.mock('../src/logger')

const { fork } = require('child_process') as { fork: jest.Mock }
const { existsSync } = require('fs') as { existsSync: jest.Mock }

describe('ChildProcessManager', () => {
  let manager: ChildProcessManager

  beforeEach(() => {
    jest.clearAllMocks()
    manager = new ChildProcessManager()
  })

  const project = { tenantCode: 'mbc', projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api' }
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
      expect(manager.hasProject(project)).toBe(true)
    })

    it('should return false for unknown project', () => {
      const unknown = { tenantCode: 'mbc', projectCode: 'proj-unknown', token: 't', apiUrl: 'http://api' }
      expect(manager.hasProject(unknown)).toBe(false)
    })

    it('should distinguish projects with same projectCode but different tenantCode', () => {
      const projectTenantA = { tenantCode: 'tenant-a', projectCode: 'PROJ_1', token: 'tok-a', apiUrl: 'http://api-a' }
      const projectTenantB = { tenantCode: 'tenant-b', projectCode: 'PROJ_1', token: 'tok-b', apiUrl: 'http://api-b' }

      manager.forkProject(projectTenantA, 'agent-1', options)
      expect(manager.hasProject(projectTenantA)).toBe(true)
      expect(manager.hasProject(projectTenantB)).toBe(false)

      manager.forkProject(projectTenantB, 'agent-1', options)
      expect(manager.hasProject(projectTenantA)).toBe(true)
      expect(manager.hasProject(projectTenantB)).toBe(true)
      expect(manager.getRunningCount()).toBe(2)
    })
  })

  describe('stopProject', () => {
    it('should send shutdown and remove project after exit', async () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value

      expect(manager.hasProject(project)).toBe(true)

      const stopPromise = manager.stopProject(project)

      expect(child.send).toHaveBeenCalledWith({ type: 'shutdown' })

      // Simulate child exit
      child._emit('exit', 0, null)

      await stopPromise

      expect(manager.hasProject(project)).toBe(false)
    })

    it('should do nothing for unknown project', async () => {
      const unknown = { tenantCode: 'mbc', projectCode: 'proj-unknown', token: 't', apiUrl: 'http://api' }
      await manager.stopProject(unknown)
      // Should not throw
    })

    it('should cancel pending restart timer when stopping a project', async () => {
      jest.useFakeTimers()
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value

      // Simulate unexpected exit to trigger restart timer
      child._emit('exit', 1, null)

      // Stop the project before the restart timer fires
      const stopPromise = manager.stopProject(project, 100)
      jest.advanceTimersByTime(100)
      await stopPromise

      // Even after restart delay the fork should not be called again (timer cancelled)
      jest.advanceTimersByTime(10000)
      expect(fork).toHaveBeenCalledTimes(1)
      expect(manager.hasProject(project)).toBe(false)

      jest.useRealTimers()
    })

    it('should force kill if child does not exit within timeout', async () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value

      jest.useFakeTimers()

      const stopPromise = manager.stopProject(project, 100)

      // Don't emit exit — let it timeout
      jest.advanceTimersByTime(200)

      await stopPromise

      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(manager.hasProject(project)).toBe(false)

      jest.useRealTimers()
    })
  })

  describe('sendTokenUpdate', () => {
    it('should send token_update to connected child', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value

      manager.sendTokenUpdate(project, 'new-token')

      expect(child.send).toHaveBeenCalledWith({ type: 'token_update', token: 'new-token' })
    })

    it('should do nothing for unknown project', () => {
      const unknown = { tenantCode: 'mbc', projectCode: 'proj-unknown', token: 't', apiUrl: 'http://api' }
      manager.sendTokenUpdate(unknown, 'new-token')
      // Should not throw
    })
  })

  describe('getRunningCount', () => {
    it('should return the number of forked projects', () => {
      expect(manager.getRunningCount()).toBe(0)

      manager.forkProject(project, 'agent-1', options)
      expect(manager.getRunningCount()).toBe(1)

      manager.forkProject(
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
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
          child._emit('message', { type: 'busy_response', tenantCode: 'mbc', projectCode: 'proj-a', busy: false })
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
          child._emit('message', { type: 'busy_response', tenantCode: 'mbc', projectCode: 'proj-a', busy: true })
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
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
        'agent-1',
        options,
      )

      const children = fork.mock.results.map((r: { value: unknown }) => r.value) as any[]

      // proj-a is not busy, proj-b is busy
      children[0].send.mockImplementation((msg: { type: string }) => {
        if (msg.type === 'busy_query') {
          children[0]._emit('message', { type: 'busy_response', tenantCode: 'mbc', projectCode: 'proj-a', busy: false })
        }
      })
      children[1].send.mockImplementation((msg: { type: string }) => {
        if (msg.type === 'busy_query') {
          children[1]._emit('message', { type: 'busy_response', tenantCode: 'mbc', projectCode: 'proj-b', busy: true })
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

    it('should correctly distinguish busy state across tenants with same projectCode', async () => {
      const projectTenantA = { tenantCode: 'tenant-a', projectCode: 'PROJ_1', token: 'tok-a', apiUrl: 'http://api-a' }
      const projectTenantB = { tenantCode: 'tenant-b', projectCode: 'PROJ_1', token: 'tok-b', apiUrl: 'http://api-b' }

      manager.forkProject(projectTenantA, 'agent-1', options)
      manager.forkProject(projectTenantB, 'agent-1', options)

      const children = fork.mock.results.map((r: { value: unknown }) => r.value) as any[]

      // tenant-a not busy, tenant-b is busy — same projectCode 'PROJ_1'
      children[0].send.mockImplementation((msg: { type: string }) => {
        if (msg.type === 'busy_query') {
          children[0]._emit('message', { type: 'busy_response', tenantCode: 'tenant-a', projectCode: 'PROJ_1', busy: false })
        }
      })
      children[1].send.mockImplementation((msg: { type: string }) => {
        if (msg.type === 'busy_query') {
          children[1]._emit('message', { type: 'busy_response', tenantCode: 'tenant-b', projectCode: 'PROJ_1', busy: true })
        }
      })

      const result = await manager.isAnyBusy()
      expect(result).toBe(true)
    })
  })

  describe('update_complete message', () => {
    it('should call onUpdateComplete with project when worker sends update_complete', () => {
      const onUpdateComplete = jest.fn()
      manager.onUpdateComplete = onUpdateComplete

      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      child._emit('message', { type: 'update_complete', tenantCode: 'mbc', projectCode: 'proj-a' })

      expect(onUpdateComplete).toHaveBeenCalledWith(project)
    })

    it('should not throw when onUpdateComplete is not set', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      expect(() => {
        child._emit('message', { type: 'update_complete', tenantCode: 'mbc', projectCode: 'proj-a' })
      }).not.toThrow()
    })
  })

  describe('stopAll', () => {
    it('should send shutdown to all children and wait for exit', async () => {
      manager.forkProject(project, 'agent-1', options)
      manager.forkProject(
        { tenantCode: 'mbc', projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' },
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

    it('should skip disconnected children when shutting down all', async () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any
      child.connected = false

      jest.useFakeTimers()
      const stopPromise = manager.stopAll(100)
      jest.advanceTimersByTime(200)
      await stopPromise

      // child.send should not have been called with shutdown (was connected=false)
      expect(child.send).not.toHaveBeenCalledWith({ type: 'shutdown' })
      expect(manager.getRunningCount()).toBe(0)
      jest.useRealTimers()
    })
  })

  describe('spawnChild: .js file path', () => {
    it('should use empty execArgv when .js worker file exists', () => {
      existsSync.mockReturnValue(true)

      manager.forkProject(project, 'agent-1', options)

      const [, , forkOptions] = fork.mock.calls[0]
      expect(forkOptions.execArgv).toEqual([])

      existsSync.mockReturnValue(false)
    })

    it('should use ts-node execArgv when .js worker file does not exist', () => {
      existsSync.mockReturnValue(false)

      manager.forkProject(project, 'agent-1', options)

      const [, , forkOptions] = fork.mock.calls[0]
      expect(forkOptions.execArgv).toEqual(['--require', 'ts-node/register'])
    })
  })

  describe('handleChildMessage', () => {
    it('should handle started message when managed is null (key removed between fork and message)', () => {
      // This tests the `if (managed)` guard on line 93 when managed is absent
      // We indirectly trigger handleChildMessage via the message event on a forked child
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      // Remove from processes map so managed will be undefined in handleChildMessage
      ;(manager as any).processes.delete(`mbc/proj-a`)

      // Should not throw even though managed is undefined
      expect(() => {
        child._emit('message', { type: 'started', tenantCode: 'mbc', projectCode: 'proj-a' })
      }).not.toThrow()
    })

    it('should handle error message from child', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      expect(() => {
        child._emit('message', { type: 'error', tenantCode: 'mbc', projectCode: 'proj-a', message: 'something went wrong' })
      }).not.toThrow()
    })

    it('should handle stopped message from child', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      expect(() => {
        child._emit('message', { type: 'stopped', tenantCode: 'mbc', projectCode: 'proj-a' })
      }).not.toThrow()
    })

    it('should reset restartCount to 0 on started message', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any
      const key = 'mbc/proj-a'
      const managed = (manager as any).processes.get(key)
      managed.restartCount = 3

      child._emit('message', { type: 'started', tenantCode: 'mbc', projectCode: 'proj-a' })

      expect(managed.restartCount).toBe(0)
    })
  })

  describe('handleChildExit', () => {
    it('should do nothing when managed is null (key already removed)', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      // Remove the entry so handleChildExit finds no managed process
      ;(manager as any).processes.delete('mbc/proj-a')

      expect(() => {
        child._emit('exit', 1, null)
      }).not.toThrow()

      // No restart timer should be set
      expect((manager as any).restartTimers.size).toBe(0)
    })

    it('should not restart when restartCount >= CHILD_PROCESS_MAX_RESTARTS', () => {
      jest.useFakeTimers()

      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any
      const key = 'mbc/proj-a'
      const managed = (manager as any).processes.get(key)

      // Set restartCount to the maximum
      managed.restartCount = CHILD_PROCESS_MAX_RESTARTS

      child._emit('exit', 1, null)

      // Process should be removed and no restart timer created
      expect(manager.hasProject(project)).toBe(false)
      expect((manager as any).restartTimers.size).toBe(0)

      // Even after waiting, fork should only have been called once (initial)
      jest.advanceTimersByTime(60000)
      expect(fork).toHaveBeenCalledTimes(1)

      jest.useRealTimers()
    })

    it('should not restart when stopping=true at timer fire time', () => {
      jest.useFakeTimers()

      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      // Trigger an exit to schedule restart timer
      child._emit('exit', 1, null)

      // Before the timer fires, set stopping = true
      ;(manager as any).stopping = true

      // Fire the restart timer
      jest.advanceTimersByTime(60000)

      // fork should still only have been called once (no restart)
      expect(fork).toHaveBeenCalledTimes(1)

      jest.useRealTimers()
    })
  })

  describe('sendUpdateToAll', () => {
    it('should skip disconnected children', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any
      child.connected = false

      manager.sendUpdateToAll()

      // send should only have been called with the initial start message, not update
      const updateCalls = (child.send as jest.Mock).mock.calls.filter(
        (call: unknown[]) => (call[0] as { type: string }).type === 'update',
      )
      expect(updateCalls).toHaveLength(0)
    })

    it('should send update to connected children', () => {
      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any
      // child.connected is true by default from the mock

      manager.sendUpdateToAll()

      expect(child.send).toHaveBeenCalledWith({ type: 'update' })
    })
  })

  describe('handleChildExit: normal restart', () => {
    it('should spawn a new child after restart delay when not stopping', () => {
      jest.useFakeTimers()

      manager.forkProject(project, 'agent-1', options)
      const child = fork.mock.results[0].value as any

      // Trigger exit to schedule restart
      child._emit('exit', 1, null)

      expect(fork).toHaveBeenCalledTimes(1)

      // Advance past the restart delay
      jest.advanceTimersByTime(60000)

      // A new child should have been forked
      expect(fork).toHaveBeenCalledTimes(2)

      jest.useRealTimers()
    })
  })
})
