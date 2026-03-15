import { ProcessManager, getProcessManager, cancelProcess, _getRunningProcesses } from '../../src/commands/process-manager'

describe('ProcessManager', () => {
  let pm: ProcessManager

  beforeEach(() => {
    pm = new ProcessManager()
  })

  describe('register', () => {
    it('should register a handle that can be retrieved via _getRunning', () => {
      const handle = { cancel: jest.fn() }
      pm.register('cmd-1', handle)

      expect(pm._getRunning().has('cmd-1')).toBe(true)
      expect(pm._getRunning().get('cmd-1')).toBe(handle)
    })

    it('should overwrite an existing entry with the same id', () => {
      const handle1 = { cancel: jest.fn() }
      const handle2 = { cancel: jest.fn() }
      pm.register('cmd-1', handle1)
      pm.register('cmd-1', handle2)

      expect(pm._getRunning().get('cmd-1')).toBe(handle2)
    })
  })

  describe('cancel', () => {
    it('should call cancel() on the handle and remove it from the map', () => {
      const cancelFn = jest.fn()
      pm.register('cmd-1', { cancel: cancelFn })

      const result = pm.cancel('cmd-1')

      expect(result).toBe(true)
      expect(cancelFn).toHaveBeenCalledTimes(1)
      expect(pm._getRunning().has('cmd-1')).toBe(false)
    })

    it('should return false when id does not exist', () => {
      const result = pm.cancel('nonexistent')

      expect(result).toBe(false)
    })

    it('should not affect other registered handles', () => {
      const cancel1 = jest.fn()
      const cancel2 = jest.fn()
      pm.register('cmd-1', { cancel: cancel1 })
      pm.register('cmd-2', { cancel: cancel2 })

      pm.cancel('cmd-1')

      expect(cancel1).toHaveBeenCalledTimes(1)
      expect(cancel2).not.toHaveBeenCalled()
      expect(pm._getRunning().has('cmd-1')).toBe(false)
      expect(pm._getRunning().has('cmd-2')).toBe(true)
    })
  })

  describe('remove', () => {
    it('should remove the handle without calling cancel()', () => {
      const cancelFn = jest.fn()
      pm.register('cmd-1', { cancel: cancelFn })

      pm.remove('cmd-1')

      expect(cancelFn).not.toHaveBeenCalled()
      expect(pm._getRunning().has('cmd-1')).toBe(false)
    })

    it('should be a no-op when id does not exist', () => {
      // Should not throw
      pm.remove('nonexistent')
      expect(pm._getRunning().size).toBe(0)
    })

    it('should cause subsequent cancel to return false', () => {
      pm.register('cmd-1', { cancel: jest.fn() })
      pm.remove('cmd-1')

      const result = pm.cancel('cmd-1')
      expect(result).toBe(false)
    })
  })

  describe('_getRunning', () => {
    it('should return an empty map initially', () => {
      expect(pm._getRunning().size).toBe(0)
    })

    it('should reflect all registered handles', () => {
      pm.register('a', { cancel: jest.fn() })
      pm.register('b', { cancel: jest.fn() })
      pm.register('c', { cancel: jest.fn() })

      expect(pm._getRunning().size).toBe(3)
    })
  })
})

describe('getProcessManager (singleton)', () => {
  it('should return the same instance on every call', () => {
    const instance1 = getProcessManager()
    const instance2 = getProcessManager()

    expect(instance1).toBe(instance2)
  })

  it('should return an instance of ProcessManager', () => {
    const instance = getProcessManager()

    expect(instance).toBeInstanceOf(ProcessManager)
  })
})

describe('cancelProcess (unified)', () => {
  afterEach(() => {
    // Cleanup singleton state
    const running = _getRunningProcesses()
    for (const key of running.keys()) {
      running.delete(key)
    }
  })

  it('should cancel a process registered via the singleton', () => {
    const cancelFn = jest.fn()
    const pm = getProcessManager()
    pm.register('cmd-unified', { cancel: cancelFn })

    const result = cancelProcess('cmd-unified')

    expect(result).toBe(true)
    expect(cancelFn).toHaveBeenCalledTimes(1)
  })

  it('should return false when commandId is not found', () => {
    const result = cancelProcess('nonexistent')
    expect(result).toBe(false)
  })
})

describe('_getRunningProcesses (unified)', () => {
  afterEach(() => {
    const running = _getRunningProcesses()
    for (const key of running.keys()) {
      running.delete(key)
    }
  })

  it('should return the singleton running map', () => {
    const pm = getProcessManager()
    const handle = { cancel: jest.fn() }
    pm.register('cmd-check', handle)

    const running = _getRunningProcesses()

    expect(running.has('cmd-check')).toBe(true)
    expect(running.get('cmd-check')).toBe(handle)

    // Cleanup
    pm.remove('cmd-check')
  })
})
