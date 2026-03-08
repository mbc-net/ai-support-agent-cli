import { ProcessManager } from '../../src/commands/process-manager'

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
