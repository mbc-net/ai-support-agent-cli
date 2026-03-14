import { withValidatedPath } from '../../src/commands/file-path-guard'
import { ERR_NO_FILE_PATH_SPECIFIED } from '../../src/constants'
import type { CommandResult } from '../../src/types'

describe('file-path-guard', () => {
  describe('withValidatedPath', () => {
    it('should call handler with resolved path when path is valid', async () => {
      const handler = jest.fn<Promise<CommandResult>, [string]>().mockResolvedValue({
        success: true,
        data: 'ok',
      })

      const result = await withValidatedPath({ path: '/tmp' }, handler)

      expect(result).toEqual({ success: true, data: 'ok' })
      expect(handler).toHaveBeenCalledWith('/tmp')
    })

    it('should return error when path is missing and no default', async () => {
      const handler = jest.fn()

      const result = await withValidatedPath({}, handler)

      expect(result).toEqual({ success: false, error: ERR_NO_FILE_PATH_SPECIFIED })
      expect(handler).not.toHaveBeenCalled()
    })

    it('should use defaultPath when path is not provided', async () => {
      const handler = jest.fn<Promise<CommandResult>, [string]>().mockResolvedValue({
        success: true,
        data: 'listed',
      })

      const result = await withValidatedPath({}, handler, '.')

      expect(result).toEqual({ success: true, data: 'listed' })
      expect(handler).toHaveBeenCalledWith('.')
    })

    it('should return access denied for blocked paths', async () => {
      const handler = jest.fn()

      const result = await withValidatedPath({ path: '/etc/shadow' }, handler)

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Access denied')
      }
      expect(handler).not.toHaveBeenCalled()
    })

    it('should propagate errors thrown by handler', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('handler error'))

      await expect(
        withValidatedPath({ path: '/tmp' }, handler),
      ).rejects.toThrow('handler error')
    })

    it('should resolve relative path against baseDir', async () => {
      const handler = jest.fn<Promise<CommandResult>, [string]>().mockResolvedValue({
        success: true,
        data: 'ok',
      })

      const result = await withValidatedPath({ path: 'subdir' }, handler, undefined, '/tmp')

      expect(result).toEqual({ success: true, data: 'ok' })
      expect(handler).toHaveBeenCalledWith('/tmp/subdir')
    })
  })
})
