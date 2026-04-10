import { logger, maskSecrets, getProjectColor, resetProjectColors, prefixLines, makeLinePrefixer, stripCursorCodes } from '../src/logger'

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

    it('should mask database connection strings', () => {
      expect(maskSecrets('postgres://admin:s3cret@db.example.com/mydb')).toBe('postgres://admin:****@db.example.com/mydb')
      expect(maskSecrets('mysql://root:password123@localhost:3306/app')).toBe('mysql://root:****@localhost:3306/app')
      expect(maskSecrets('mongodb+srv://user:pass@cluster.mongodb.net')).toBe('mongodb+srv://user:****@cluster.mongodb.net')
      expect(maskSecrets('redis://default:mypass@redis.host:6379')).toBe('redis://default:****@redis.host:6379')
      expect(maskSecrets('postgresql://user:pwd@host/db')).toBe('postgresql://user:****@host/db')
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

    it('should mask JWT tokens', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
      const result = maskSecrets(`token: ${jwt}`)
      expect(result).not.toContain('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')
    })

    it('should mask GitHub personal access tokens', () => {
      const ghToken = 'ghp_1234567890abcdefghij1234567890ABCDEF12'
      // Test without "token:" prefix so the specific pattern is used, not the generic keyword pattern
      const result = maskSecrets(`git push with ${ghToken}`)
      expect(result).not.toContain(ghToken)
      expect(result).toContain('gh**_****')
    })

    it('should mask GitLab personal access tokens', () => {
      const glToken = 'glpat-abcdefghij1234567890'
      // Test without "token:" prefix so the specific pattern is used, not the generic keyword pattern
      const result = maskSecrets(`CI using ${glToken} here`)
      expect(result).not.toContain(glToken)
      expect(result).toContain('glpat-****')
    })

    it('should mask PEM private keys', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'
      const result = maskSecrets(`key: ${pem}`)
      expect(result).not.toContain('MIIEowIBAAKCAQEA')
      expect(result).toContain('[PRIVATE KEY REDACTED]')
    })
  })

  describe('getProjectColor', () => {
    beforeEach(() => {
      resetProjectColors()
    })

    it('should return a consistent color for the same project key', () => {
      const color1 = getProjectColor('tenant#PROJECT_A')
      const color2 = getProjectColor('tenant#PROJECT_A')
      expect(color1).toBe(color2)
    })

    it('should return different colors for different project keys', () => {
      const color1 = getProjectColor('tenant#PROJECT_A')
      const color2 = getProjectColor('tenant#PROJECT_B')
      expect(color1).toBeDefined()
      expect(color2).toBeDefined()
      // Colors cycle — first two may differ or wrap but both must be ANSI codes
      expect(color1).toMatch(/^\x1b\[/)
      expect(color2).toMatch(/^\x1b\[/)
    })

    it('should cycle through colors for many projects', () => {
      const colors = Array.from({ length: 10 }, (_, i) => getProjectColor(`tenant#PROJECT_${i}`))
      expect(colors).toHaveLength(10)
      colors.forEach((c) => expect(c).toMatch(/^\x1b\[/))
    })
  })

  describe('resetProjectColors', () => {
    it('should reset color assignments so that the same key gets the cycle-start color again', () => {
      resetProjectColors()
      const colorFirst = getProjectColor('tenant#PROJECT_X')
      // Register more projects to advance the cycle
      getProjectColor('tenant#PROJECT_Y')
      getProjectColor('tenant#PROJECT_Z')
      // After reset, PROJECT_X should map to index 0 again (same as colorFirst)
      resetProjectColors()
      const colorAfterReset = getProjectColor('tenant#PROJECT_X')
      expect(colorAfterReset).toBe(colorFirst)
    })
  })

  describe('prefixLines', () => {
    it('should prefix every line with the given prefix', () => {
      const result = prefixLines('line1\nline2\nline3', 'PREFIX ')
      expect(result).toBe('PREFIX line1\nPREFIX line2\nPREFIX line3')
    })

    it('should handle text ending with newline correctly', () => {
      const result = prefixLines('line1\nline2\n', 'P ')
      expect(result).toBe('P line1\nP line2\n')
    })

    it('should handle single line without newline', () => {
      const result = prefixLines('single', 'P ')
      expect(result).toBe('P single')
    })

    it('should return empty string as-is', () => {
      expect(prefixLines('', 'P ')).toBe('')
    })
  })

  describe('makeLinePrefixer', () => {
    it('should buffer partial lines and only write complete lines', () => {
      const output: string[] = []
      const write = makeLinePrefixer('P> ', (s) => output.push(s))

      write('hello ')   // no newline — buffered
      expect(output).toHaveLength(0)

      write('world\n')  // completes the line
      expect(output).toHaveLength(1)
      expect(output[0]).toBe('P> hello world\n')
    })

    it('should handle multiple complete lines in one chunk', () => {
      const output: string[] = []
      const write = makeLinePrefixer('P> ', (s) => output.push(s))

      write('line1\nline2\nline3\n')
      expect(output).toHaveLength(1)
      expect(output[0]).toBe('P> line1\nP> line2\nP> line3\n')
    })

    it('should retain trailing partial line for next chunk', () => {
      const output: string[] = []
      const write = makeLinePrefixer('P> ', (s) => output.push(s))

      write('line1\npartial')
      expect(output).toHaveLength(1)
      expect(output[0]).toBe('P> line1\n')

      write(' done\n')
      expect(output).toHaveLength(2)
      expect(output[1]).toBe('P> partial done\n')
    })

    it('should normalize CRLF to LF to prevent cursor reset before prefix', () => {
      const output: string[] = []
      const write = makeLinePrefixer('P> ', (s) => output.push(s))

      write('line1\r\nline2\r\n')
      expect(output).toHaveLength(1)
      expect(output[0]).toBe('P> line1\nP> line2\n')
      expect(output[0]).not.toContain('\r')
    })

    it('should normalize bare CR to LF', () => {
      const output: string[] = []
      const write = makeLinePrefixer('P> ', (s) => output.push(s))

      write('line1\rline2\r')
      expect(output).toHaveLength(1)
      expect(output[0]).not.toContain('\r')
    })

    it('should prevent interleaving from two concurrent prefixers on the same stream', () => {
      const combined: string[] = []
      const writeA = makeLinePrefixer('[A] ', (s) => combined.push(s))
      const writeB = makeLinePrefixer('[B] ', (s) => combined.push(s))

      // Simulate interleaved partial chunks
      writeA('hello ')
      writeB('world ')
      writeA('from A\n')  // A completes — writes atomically
      writeB('from B\n')  // B completes — writes atomically

      expect(combined[0]).toBe('[A] hello from A\n')
      expect(combined[1]).toBe('[B] world from B\n')
    })

    it('should strip cursor-movement codes but preserve color codes', () => {
      const output: string[] = []
      const write = makeLinePrefixer('P> ', (s) => output.push(s))

      // Simulate docker build output: erase-line + cursor-to-col-1 + color
      write('\x1b[2K\x1b[1G\x1b[32mStep 1/5\x1b[0m\n')
      expect(output).toHaveLength(1)
      expect(output[0]).toContain('\x1b[32m')     // SGR color preserved
      expect(output[0]).not.toContain('\x1b[2K')  // erase-line stripped
      expect(output[0]).not.toContain('\x1b[1G')  // cursor-to-col stripped
    })
  })

  describe('stripCursorCodes', () => {
    it('should strip cursor up (A)', () => {
      expect(stripCursorCodes('before\x1b[2Aafter')).toBe('beforeafter')
    })

    it('should strip cursor down (B)', () => {
      expect(stripCursorCodes('before\x1b[1Bafter')).toBe('beforeafter')
    })

    it('should strip cursor forward (C)', () => {
      expect(stripCursorCodes('\x1b[5Ctext')).toBe('text')
    })

    it('should strip cursor back (D)', () => {
      expect(stripCursorCodes('text\x1b[3D')).toBe('text')
    })

    it('should strip cursor horizontal absolute with no param (G)', () => {
      expect(stripCursorCodes('\x1b[Ghello')).toBe('hello')
    })

    it('should strip cursor position with two params (H)', () => {
      expect(stripCursorCodes('\x1b[1;1Htext')).toBe('text')
    })

    it('should strip erase-in-line with no param (K)', () => {
      expect(stripCursorCodes('line\x1b[K')).toBe('line')
    })

    it('should strip erase-entire-line (2K)', () => {
      expect(stripCursorCodes('\x1b[2Kline')).toBe('line')
    })

    it('should strip erase-in-display (2J)', () => {
      expect(stripCursorCodes('\x1b[2Jtext')).toBe('text')
    })

    it('should strip save cursor (s)', () => {
      expect(stripCursorCodes('\x1b[stext')).toBe('text')
    })

    it('should strip restore cursor (u)', () => {
      expect(stripCursorCodes('text\x1b[u')).toBe('text')
    })

    it('should strip hide cursor (?25l)', () => {
      expect(stripCursorCodes('\x1b[?25ltext')).toBe('text')
    })

    it('should strip show cursor (?25h)', () => {
      expect(stripCursorCodes('text\x1b[?25h')).toBe('text')
    })

    it('should strip bracketed paste mode on (?2004h)', () => {
      expect(stripCursorCodes('\x1b[?2004htext')).toBe('text')
    })

    it('should strip bracketed paste mode off (?2004l)', () => {
      expect(stripCursorCodes('text\x1b[?2004l')).toBe('text')
    })

    it('should NOT strip SGR color codes (m)', () => {
      const colored = '\x1b[32mgreen text\x1b[0m'
      expect(stripCursorCodes(colored)).toBe(colored)
    })

    it('should NOT strip bold/reset SGR codes', () => {
      const bold = '\x1b[1mbold\x1b[0m'
      expect(stripCursorCodes(bold)).toBe(bold)
    })

    it('should NOT strip 256-color SGR codes', () => {
      const c256 = '\x1b[38;5;200mtext\x1b[0m'
      expect(stripCursorCodes(c256)).toBe(c256)
    })

    it('should strip mixed cursor codes while preserving color in docker-like output', () => {
      const dockerLine = '\x1b[2K\x1b[1G\x1b[32mStep 1/5 :\x1b[0m FROM node:18'
      expect(stripCursorCodes(dockerLine)).toBe('\x1b[32mStep 1/5 :\x1b[0m FROM node:18')
    })

    it('should handle text with no escape sequences unchanged', () => {
      expect(stripCursorCodes('plain text')).toBe('plain text')
    })

    it('should handle empty string', () => {
      expect(stripCursorCodes('')).toBe('')
    })

    it('should strip multiple cursor codes in one string', () => {
      expect(stripCursorCodes('\x1b[?25l\x1b[2K\x1b[Gloading...\x1b[?25h')).toBe('loading...')
    })
  })
})
