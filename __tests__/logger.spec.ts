import { logger } from '../src/logger'

describe('logger', () => {
  let logSpy: jest.Spied<typeof console.log>
  let errorSpy: jest.Spied<typeof console.error>

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation()
    errorSpy = jest.spyOn(console, 'error').mockImplementation()
    logger.setVerbose(false)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('info', () => {
    it('should output INFO formatted message to console.log', () => {
      logger.info('test message')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('INFO')
      expect(logSpy.mock.calls[0][0]).toContain('test message')
    })
  })

  describe('warn', () => {
    it('should output WARN formatted message to console.log', () => {
      logger.warn('warning message')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('WARN')
      expect(logSpy.mock.calls[0][0]).toContain('warning message')
    })
  })

  describe('error', () => {
    it('should output ERROR formatted message to console.error', () => {
      logger.error('error message')
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0][0]).toContain('ERROR')
      expect(errorSpy.mock.calls[0][0]).toContain('error message')
    })
  })

  describe('success', () => {
    it('should output message with checkmark to console.log', () => {
      logger.success('done')
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = logSpy.mock.calls[0][0] as string
      expect(output).toContain('done')
    })
  })

  describe('debug', () => {
    it('should not output when verbose is false', () => {
      logger.debug('hidden message')
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('should output DEBUG formatted message when verbose is true', () => {
      logger.setVerbose(true)
      logger.debug('debug message')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('DEBUG')
      expect(logSpy.mock.calls[0][0]).toContain('debug message')
    })
  })

  describe('setVerbose', () => {
    it('should enable debug output when set to true', () => {
      logger.setVerbose(true)
      logger.debug('visible')
      expect(logSpy).toHaveBeenCalledTimes(1)
    })

    it('should disable debug output when set back to false', () => {
      logger.setVerbose(true)
      logger.setVerbose(false)
      logger.debug('hidden')
      expect(logSpy).not.toHaveBeenCalled()
    })
  })
})
