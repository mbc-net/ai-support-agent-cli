import { logger, maskSecrets } from '../src/logger'

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

  describe('secret masking', () => {
    it('should mask log messages containing secrets', () => {
      logger.info('password: my-secret-pass')
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = logSpy.mock.calls[0][0] as string
      expect(output).not.toContain('my-secret-pass')
      expect(output).toContain('****')
    })

    it('should mask Bearer tokens in log output', () => {
      logger.info('Header: Bearer eyJhbGciOiJIUzI1NiJ9.token')
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = logSpy.mock.calls[0][0] as string
      expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9.token')
      expect(output).toContain('Bearer ****')
    })

    it('should mask AWS access key IDs in log output', () => {
      logger.info('Found key: AKIAIOSFODNN7EXAMPLE')
      expect(logSpy).toHaveBeenCalledTimes(1)
      const output = logSpy.mock.calls[0][0] as string
      expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE')
      expect(output).toContain('AKIA****')
    })
  })

  describe('maskSecrets', () => {
    it('should mask password values', () => {
      expect(maskSecrets('password: my-secret')).toBe('password: ****')
      expect(maskSecrets('password=my-secret')).toBe('password=****')
      expect(maskSecrets('password: "my-secret"')).toBe('password: "****"')
    })

    it('should mask token values', () => {
      expect(maskSecrets('token: abc123')).toBe('token: ****')
      expect(maskSecrets('token=abc123')).toBe('token=****')
    })

    it('should mask secret values', () => {
      expect(maskSecrets('secret: supersecret')).toBe('secret: ****')
    })

    it('should mask api_key values', () => {
      expect(maskSecrets('api_key: da2-abcdef')).toBe('api_key: ****')
      expect(maskSecrets('apikey=some-key')).toBe('apikey=****')
    })

    it('should mask access_key values', () => {
      expect(maskSecrets('access_key: AKIAIOSFODNN7EXAMPLE')).toBe('access_key: ****')
    })

    it('should mask secret_key values', () => {
      expect(maskSecrets('secret_key: wJalrXUtnFEMI/K7MDENG')).toBe('secret_key: ****')
    })

    it('should mask session_token values', () => {
      expect(maskSecrets('session_token: FwoGZX...')).toBe('session_token: ****')
    })

    it('should mask Bearer tokens', () => {
      expect(maskSecrets('Bearer eyJhbGciOiJIUzI1NiJ9')).toBe('Bearer ****')
    })

    it('should mask AWS access key IDs', () => {
      expect(maskSecrets('key is AKIAIOSFODNN7EXAMPLE')).toBe('key is AKIA****')
    })

    it('should not modify messages without secrets', () => {
      const message = 'This is a normal log message'
      expect(maskSecrets(message)).toBe(message)
    })

    it('should handle multiple secrets in one message', () => {
      const result = maskSecrets('password: abc token: def')
      expect(result).not.toContain('abc')
      expect(result).not.toContain('def')
      expect(result).toContain('****')
    })

    it('should be case insensitive for key names', () => {
      expect(maskSecrets('PASSWORD: secret')).toBe('PASSWORD: ****')
      expect(maskSecrets('Token: secret')).toBe('Token: ****')
      expect(maskSecrets('API_KEY: secret')).toBe('API_KEY: ****')
    })
  })
})
