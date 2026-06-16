import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AxiosError, AxiosHeaders } from 'axios'
import { exitWithError, getErrorMessage, isInDocker, parseString, parseNumber, truncateString, validateApiUrl, atomicWriteFile, ensureDir, isAuthenticationError, isSsoAuthRequiredError, buildWsUrl, resolveUrlForDocker, isErrnoException, readJsonSync, sleep, toErrorMessage, toError, toContainerApiUrl, sanitizeNameSegment } from '../src/utils'
import { ENV_VARS } from '../src/constants'

describe('sanitizeNameSegment', () => {
  it('lowercases uppercase input', () => {
    expect(sanitizeNameSegment('MBC')).toBe('mbc')
  })

  it('collapses characters outside [a-z0-9-] to hyphens', () => {
    expect(sanitizeNameSegment('MBC_01')).toBe('mbc-01')
    expect(sanitizeNameSegment('MY.PROJECT')).toBe('my-project')
    expect(sanitizeNameSegment('a b;c=d/e\\f')).toBe('a-b-c-d-e-f')
  })

  it('leaves already-safe values unchanged', () => {
    expect(sanitizeNameSegment('mbc-01')).toBe('mbc-01')
    expect(sanitizeNameSegment('abc123')).toBe('abc123')
  })

  it('returns empty string for empty input', () => {
    expect(sanitizeNameSegment('')).toBe('')
  })
})

describe('getErrorMessage', () => {
  it('should return message from Error instance', () => {
    expect(getErrorMessage(new Error('test error'))).toBe('test error')
  })

  it('should return string as-is', () => {
    expect(getErrorMessage('string error')).toBe('string error')
  })

  it('should convert number to string', () => {
    expect(getErrorMessage(42)).toBe('42')
  })

  it('should convert null to string', () => {
    expect(getErrorMessage(null)).toBe('null')
  })

  it('should convert undefined to string', () => {
    expect(getErrorMessage(undefined)).toBe('undefined')
  })

  it('should handle TypeError', () => {
    expect(getErrorMessage(new TypeError('type error'))).toBe('type error')
  })
})

describe('toErrorMessage', () => {
  it('should return message from Error instance', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('should return message from Error subclasses', () => {
    expect(toErrorMessage(new TypeError('type boom'))).toBe('type boom')
  })

  it('should stringify a non-Error string', () => {
    expect(toErrorMessage('plain string')).toBe('plain string')
  })

  it('should stringify a number', () => {
    expect(toErrorMessage(42)).toBe('42')
  })

  it('should stringify null', () => {
    expect(toErrorMessage(null)).toBe('null')
  })

  it('should stringify undefined', () => {
    expect(toErrorMessage(undefined)).toBe('undefined')
  })
})

describe('toError', () => {
  it('should return the same Error instance unchanged', () => {
    const original = new Error('keep me')
    expect(toError(original)).toBe(original)
  })

  it('should return Error subclass instances unchanged', () => {
    const original = new TypeError('type error')
    expect(toError(original)).toBe(original)
  })

  it('should wrap a non-Error string into an Error', () => {
    const result = toError('wrap me')
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('wrap me')
  })

  it('should wrap a number into an Error', () => {
    const result = toError(500)
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('500')
  })

  it('should wrap null into an Error', () => {
    const result = toError(null)
    expect(result).toBeInstanceOf(Error)
    expect(result.message).toBe('null')
  })
})

describe('parseString', () => {
  it('should return non-empty string as-is', () => {
    expect(parseString('hello')).toBe('hello')
  })

  it('should return null for empty string', () => {
    expect(parseString('')).toBeNull()
  })

  it('should return null for non-string types', () => {
    expect(parseString(123)).toBeNull()
    expect(parseString(null)).toBeNull()
    expect(parseString(undefined)).toBeNull()
  })

  it('should return null for boolean', () => {
    expect(parseString(true)).toBeNull()
  })
})

describe('parseNumber', () => {
  it('should return valid number as-is', () => {
    expect(parseNumber(42)).toBe(42)
    expect(parseNumber(0)).toBe(0)
  })

  it('should return null for NaN', () => {
    expect(parseNumber(NaN)).toBeNull()
  })

  it('should return null for non-number types', () => {
    expect(parseNumber('123')).toBeNull()
    expect(parseNumber(null)).toBeNull()
    expect(parseNumber(undefined)).toBeNull()
  })

  it('should return negative numbers', () => {
    expect(parseNumber(-5)).toBe(-5)
  })
})

describe('truncateString', () => {
  it('should return text as-is when shorter than limit', () => {
    expect(truncateString('hello', 10)).toBe('hello')
  })

  it('should return text as-is when exactly at limit', () => {
    expect(truncateString('hello', 5)).toBe('hello')
  })

  it('should truncate and add suffix when longer than limit', () => {
    expect(truncateString('hello world', 5)).toBe('hello...')
  })

  it('should use custom suffix', () => {
    expect(truncateString('hello world', 5, ' [truncated]')).toBe('hello [truncated]')
  })

  it('should handle empty string', () => {
    expect(truncateString('', 10)).toBe('')
  })

  it('should handle limit of 0', () => {
    expect(truncateString('hello', 0)).toBe('...')
  })
})

describe('validateApiUrl', () => {
  it('should accept https URL', () => {
    expect(validateApiUrl('https://api.example.com')).toBeNull()
  })

  it('should accept http URL', () => {
    expect(validateApiUrl('http://localhost:3030')).toBeNull()
  })

  it('should reject file:// URL', () => {
    const result = validateApiUrl('file:///etc/passwd')
    expect(result).toContain('Invalid protocol')
    expect(result).toContain('file:')
  })

  it('should reject javascript: URL', () => {
    const result = validateApiUrl('javascript:alert(1)')
    expect(result).toContain('Invalid protocol')
  })

  it('should reject invalid URL string', () => {
    const result = validateApiUrl('not-a-url')
    expect(result).toContain('Invalid URL')
  })

  it('should reject empty string', () => {
    const result = validateApiUrl('')
    expect(result).toContain('Invalid URL')
  })
})

describe('atomicWriteFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('should write file with content', () => {
    const filePath = path.join(tmpDir, 'test.txt')
    atomicWriteFile(filePath, 'hello world')
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world')
  })

  it('should atomically replace existing file', () => {
    const filePath = path.join(tmpDir, 'test.txt')
    atomicWriteFile(filePath, 'original')
    atomicWriteFile(filePath, 'updated')
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('updated')
    expect(fs.existsSync(filePath + '.tmp')).toBe(false)
  })

  it('should use default mode 0o600', () => {
    const filePath = path.join(tmpDir, 'test.txt')
    atomicWriteFile(filePath, 'secure content')

    const stat = fs.statSync(filePath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('should accept custom mode', () => {
    const filePath = path.join(tmpDir, 'test.txt')
    atomicWriteFile(filePath, 'content', 0o644)

    const stat = fs.statSync(filePath)
    expect(stat.mode & 0o777).toBe(0o644)
  })

  it('should not leave tmp file after successful write', () => {
    const filePath = path.join(tmpDir, 'test.txt')
    atomicWriteFile(filePath, 'content')
    expect(fs.existsSync(filePath + '.tmp')).toBe(false)
  })
})

describe('ensureDir', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-dir-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('should create a directory that does not exist', () => {
    const dir = path.join(tmpDir, 'new-dir')
    ensureDir(dir)
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.statSync(dir).isDirectory()).toBe(true)
  })

  it('should create nested directories recursively', () => {
    const dir = path.join(tmpDir, 'a', 'b', 'c')
    ensureDir(dir)
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('should be a no-op when the directory already exists', () => {
    const dir = path.join(tmpDir, 'existing')
    fs.mkdirSync(dir)
    // Drop a file inside; ensureDir must not recreate/clear the directory.
    const marker = path.join(dir, 'marker.txt')
    fs.writeFileSync(marker, 'keep')
    ensureDir(dir)
    expect(fs.existsSync(marker)).toBe(true)
  })

  it('should apply the given mode to a newly created directory', () => {
    const dir = path.join(tmpDir, 'secure')
    ensureDir(dir, 0o700)
    const stat = fs.statSync(dir)
    expect(stat.mode & 0o777).toBe(0o700)
  })

  it('should create with default permissions when no mode is given', () => {
    const dir = path.join(tmpDir, 'default-mode')
    ensureDir(dir)
    // Directory exists and is usable; exact mode is OS/umask dependent.
    expect(fs.statSync(dir).isDirectory()).toBe(true)
  })
})

describe('getErrorMessage (Axios detailed)', () => {
  it('should extract message from Axios error response with message field', () => {
    const error = new AxiosError('Request failed with status code 401', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 401,
      statusText: 'Unauthorized',
      data: { message: 'Invalid or expired token' },
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(getErrorMessage(error)).toBe('[401] Invalid or expired token')
  })

  it('should extract error field from Axios error response', () => {
    const error = new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 403,
      statusText: 'Forbidden',
      data: { error: 'ACCESS_DENIED' },
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(getErrorMessage(error)).toBe('[403] ACCESS_DENIED')
  })

  it('should fall back to HTTP status when no message or error in data', () => {
    const error = new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status: 500,
      statusText: 'Internal Server Error',
      data: { some: 'other field' },
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(getErrorMessage(error)).toBe('HTTP 500: Request failed with status code 500')
  })

  it('should fall back to HTTP status when response data is undefined', () => {
    const error = new AxiosError('Request failed with status code 502', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status: 502,
      statusText: 'Bad Gateway',
      data: undefined,
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(getErrorMessage(error)).toBe('HTTP 502: Request failed with status code 502')
  })

  it('should fall back to basic message for AxiosError without response', () => {
    const error = new AxiosError('Network Error', 'ERR_NETWORK')
    expect(getErrorMessage(error)).toBe('Network Error')
  })

  it('should return message for non-Axios Error', () => {
    const error = new Error('generic error')
    expect(getErrorMessage(error)).toBe('generic error')
  })

  it('should convert non-Error values to string', () => {
    expect(getErrorMessage('string error')).toBe('string error')
    expect(getErrorMessage(42)).toBe('42')
    expect(getErrorMessage(null)).toBe('null')
  })
})

describe('isAuthenticationError', () => {
  it('should return true for 401 AxiosError', () => {
    const error = new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 401,
      statusText: 'Unauthorized',
      data: {},
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(isAuthenticationError(error)).toBe(true)
  })

  it('should return true for 403 AxiosError', () => {
    const error = new AxiosError('Forbidden', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 403,
      statusText: 'Forbidden',
      data: {},
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(isAuthenticationError(error)).toBe(true)
  })

  it('should return false for 500 AxiosError', () => {
    const error = new AxiosError('Server Error', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status: 500,
      statusText: 'Server Error',
      data: {},
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(isAuthenticationError(error)).toBe(false)
  })

  it('should return false for non-Axios error', () => {
    expect(isAuthenticationError(new Error('some error'))).toBe(false)
  })

  it('should return false for AxiosError without response', () => {
    const error = new AxiosError('Network Error', 'ERR_NETWORK')
    expect(isAuthenticationError(error)).toBe(false)
  })
})

describe('isSsoAuthRequiredError', () => {
  it('should return true when error field is SSO_AUTH_REQUIRED', () => {
    const error = new AxiosError('Forbidden', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 403,
      statusText: 'Forbidden',
      data: { error: 'SSO_AUTH_REQUIRED' },
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(isSsoAuthRequiredError(error)).toBe(true)
  })

  it('should return true when errorCode field is SSO_AUTH_REQUIRED', () => {
    const error = new AxiosError('Forbidden', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 403,
      statusText: 'Forbidden',
      data: { errorCode: 'SSO_AUTH_REQUIRED' },
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(isSsoAuthRequiredError(error)).toBe(true)
  })

  it('should return false when error field is a different value', () => {
    const error = new AxiosError('Forbidden', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 403,
      statusText: 'Forbidden',
      data: { error: 'ACCESS_DENIED' },
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(isSsoAuthRequiredError(error)).toBe(false)
  })

  it('should return false for AxiosError without response', () => {
    const error = new AxiosError('Network Error', 'ERR_NETWORK')
    expect(isSsoAuthRequiredError(error)).toBe(false)
  })

  it('should return false for AxiosError with null data', () => {
    const error = new AxiosError('Forbidden', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 403,
      statusText: 'Forbidden',
      data: null,
      headers: {},
      config: { headers: new AxiosHeaders() },
    })
    expect(isSsoAuthRequiredError(error)).toBe(false)
  })

  it('should return false for a non-Axios error', () => {
    expect(isSsoAuthRequiredError(new Error('some error'))).toBe(false)
  })
})

describe('buildWsUrl', () => {
  it('should convert https to wss', () => {
    expect(buildWsUrl('https://api.example.com', '/ws/terminal')).toBe('wss://api.example.com/ws/terminal')
  })

  it('should convert http to ws', () => {
    expect(buildWsUrl('http://localhost:3000', '/ws/terminal')).toBe('ws://localhost:3000/ws/terminal')
  })

  it('should strip trailing slash', () => {
    expect(buildWsUrl('https://api.example.com/', '/ws/terminal')).toBe('wss://api.example.com/ws/terminal')
  })
})

describe('resolveUrlForDocker', () => {
  const ENV_KEY = ENV_VARS.IN_DOCKER

  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  it('should return URL unchanged when not in Docker', () => {
    delete process.env[ENV_KEY]
    expect(resolveUrlForDocker('https://localhost:3000/path')).toBe('https://localhost:3000/path')
    expect(resolveUrlForDocker('wss://127.0.0.1:4000')).toBe('wss://127.0.0.1:4000')
  })

  it('should replace localhost in https URL when in Docker', () => {
    process.env[ENV_KEY] = '1'
    expect(resolveUrlForDocker('https://localhost:3000/path')).toBe('https://host.docker.internal:3000/path')
  })

  it('should replace 127.0.0.1 in https URL when in Docker', () => {
    process.env[ENV_KEY] = '1'
    expect(resolveUrlForDocker('https://127.0.0.1:3000')).toBe('https://host.docker.internal:3000')
  })

  it('should replace localhost in wss URL when in Docker', () => {
    process.env[ENV_KEY] = '1'
    expect(resolveUrlForDocker('wss://localhost:4000')).toBe('wss://host.docker.internal:4000')
  })

  it('should replace localhost in ws URL when in Docker', () => {
    process.env[ENV_KEY] = '1'
    expect(resolveUrlForDocker('ws://localhost:4000')).toBe('ws://host.docker.internal:4000')
  })

  it('should not modify non-localhost URL even when in Docker', () => {
    process.env[ENV_KEY] = '1'
    expect(resolveUrlForDocker('https://api.example.com')).toBe('https://api.example.com')
  })

  it('should handle URL without port', () => {
    process.env[ENV_KEY] = '1'
    expect(resolveUrlForDocker('https://localhost')).toBe('https://host.docker.internal')
  })
})

describe('isInDocker', () => {
  const ENV_KEY = ENV_VARS.IN_DOCKER

  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  it('returns true when AI_SUPPORT_AGENT_IN_DOCKER is "1"', () => {
    process.env[ENV_KEY] = '1'
    expect(isInDocker()).toBe(true)
  })

  it('returns false when AI_SUPPORT_AGENT_IN_DOCKER is unset', () => {
    delete process.env[ENV_KEY]
    expect(isInDocker()).toBe(false)
  })

  it('returns false when AI_SUPPORT_AGENT_IN_DOCKER is "0"', () => {
    process.env[ENV_KEY] = '0'
    expect(isInDocker()).toBe(false)
  })

  it('returns false when AI_SUPPORT_AGENT_IN_DOCKER is "true"', () => {
    process.env[ENV_KEY] = 'true'
    expect(isInDocker()).toBe(false)
  })

  it('returns false when AI_SUPPORT_AGENT_IN_DOCKER is empty string', () => {
    process.env[ENV_KEY] = ''
    expect(isInDocker()).toBe(false)
  })
})

describe('isErrnoException', () => {
  it('should return true for an Error with a code property', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    expect(isErrnoException(err)).toBe(true)
  })

  it('should return true and narrow when code matches', () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    expect(isErrnoException(err, 'ENOENT')).toBe(true)
  })

  it('should return false when code does not match', () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' })
    expect(isErrnoException(err, 'ENOENT')).toBe(false)
  })

  it('should return false for a plain Error without code', () => {
    expect(isErrnoException(new Error('no code'))).toBe(false)
  })

  it('should return false for an object without a message property', () => {
    expect(isErrnoException({ code: 'ENOENT' })).toBe(false)
  })

  it('should return true for an error-shaped plain object with message and code', () => {
    // Covers Jest isolatedModules environments where instanceof Error may fail
    expect(isErrnoException({ message: 'ENOENT: no such file', code: 'ENOENT' })).toBe(true)
  })

  it('should return false for null', () => {
    expect(isErrnoException(null)).toBe(false)
  })

  it('should return false for a string', () => {
    expect(isErrnoException('ENOENT')).toBe(false)
  })

  it('should return false for a number', () => {
    expect(isErrnoException(42)).toBe(false)
  })

  it('should return true when code argument is undefined (no code filter)', () => {
    const err = Object.assign(new Error('EPERM'), { code: 'EPERM' })
    expect(isErrnoException(err, undefined)).toBe(true)
  })
})

describe('sleep', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('should return a Promise', () => {
    jest.useFakeTimers()
    const result = sleep(1000)
    expect(result).toBeInstanceOf(Promise)
    jest.advanceTimersByTime(1000)
    return result
  })

  it('should resolve after the specified delay', async () => {
    jest.useFakeTimers()
    let resolved = false
    const promise = sleep(500).then(() => {
      resolved = true
    })

    // Not yet elapsed
    jest.advanceTimersByTime(499)
    await Promise.resolve()
    expect(resolved).toBe(false)

    // Elapsed
    jest.advanceTimersByTime(1)
    await promise
    expect(resolved).toBe(true)
  })

  it('should resolve with undefined', async () => {
    jest.useFakeTimers()
    const promise = sleep(0)
    jest.advanceTimersByTime(0)
    await expect(promise).resolves.toBeUndefined()
  })

  it('should actually wait with real timers', async () => {
    const start = Date.now()
    await sleep(20)
    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
  })
})

describe('readJsonSync', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-json-sync-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('should parse a valid JSON file and return its content', () => {
    const filePath = path.join(tmpDir, 'data.json')
    fs.writeFileSync(filePath, JSON.stringify({ key: 'value', count: 42 }))
    const result = readJsonSync<{ key: string; count: number }>(filePath)
    expect(result).toEqual({ key: 'value', count: 42 })
  })

  it('should parse a JSON array', () => {
    const filePath = path.join(tmpDir, 'array.json')
    fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]))
    const result = readJsonSync<number[]>(filePath)
    expect(result).toEqual([1, 2, 3])
  })

  it('should parse nested JSON objects', () => {
    const filePath = path.join(tmpDir, 'nested.json')
    const data = { outer: { inner: 'value' }, list: ['a', 'b'] }
    fs.writeFileSync(filePath, JSON.stringify(data))
    const result = readJsonSync<typeof data>(filePath)
    expect(result).toEqual(data)
  })

  it('should throw when the file does not exist', () => {
    const filePath = path.join(tmpDir, 'nonexistent.json')
    expect(() => readJsonSync(filePath)).toThrow()
  })

  it('should throw when the file contains invalid JSON', () => {
    const filePath = path.join(tmpDir, 'invalid.json')
    fs.writeFileSync(filePath, 'not valid json {{{')
    expect(() => readJsonSync(filePath)).toThrow()
  })
})

describe('toContainerApiUrl', () => {
  it('converts http://localhost to host.docker.internal', () => {
    expect(toContainerApiUrl('http://localhost')).toBe('http://host.docker.internal')
  })

  it('converts http://127.0.0.1 to host.docker.internal', () => {
    expect(toContainerApiUrl('http://127.0.0.1')).toBe('http://host.docker.internal')
  })

  it('preserves the port when converting localhost', () => {
    expect(toContainerApiUrl('http://localhost:4030')).toBe('http://host.docker.internal:4030')
  })

  it('preserves the port when converting 127.0.0.1', () => {
    expect(toContainerApiUrl('http://127.0.0.1:8080/api')).toBe('http://host.docker.internal:8080/api')
  })

  it('preserves a path that follows the host directly (no port)', () => {
    expect(toContainerApiUrl('http://localhost/api')).toBe('http://host.docker.internal/api')
  })

  it('converts https URLs too', () => {
    expect(toContainerApiUrl('https://localhost:8443')).toBe('https://host.docker.internal:8443')
  })

  it('does NOT replace localhost when it is a prefix of a longer hostname', () => {
    // Without the boundary lookahead, `http://localhost.example.com` would
    // partially match and become `http://host.docker.internal.example.com` —
    // a different host.  This is the regression the old inline regex had.
    expect(toContainerApiUrl('http://localhost.example.com/api')).toBe('http://localhost.example.com/api')
    expect(toContainerApiUrl('http://127.0.0.1.example.com')).toBe('http://127.0.0.1.example.com')
  })

  it('leaves non-localhost URLs unchanged', () => {
    expect(toContainerApiUrl('https://api.example.com')).toBe('https://api.example.com')
    expect(toContainerApiUrl('http://192.168.1.10:4030')).toBe('http://192.168.1.10:4030')
  })
})

describe('exitWithError', () => {
  let exitSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((_code?: number | string) => {
      throw new Error('process.exit called')
    })
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    exitSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('should call process.exit(1) with the given message', () => {
    expect(() => exitWithError('fatal error')).toThrow('process.exit called')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('should return never (TypeScript return type)', () => {
    // Verify the function is typed as `never` by confirming it always throws
    expect(() => exitWithError('another error')).toThrow()
    expect(exitSpy).toHaveBeenCalledTimes(1)
  })
})
