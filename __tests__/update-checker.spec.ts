import { execFile, execFileSync, spawn } from 'child_process'
import { accessSync } from 'fs'

import { NPM_COMMAND } from '../src/constants'
import {
  detectChannelFromVersion,
  detectInstallMethod,
  getGlobalNpmPrefix,
  hasGlobalWritePermission,
  isNewerVersion,
  isValidVersion,
  isSudoAvailable,
  performUpdate,
  reExecProcess,
  redactSecrets,
  resetGlobalPrefixCache,
} from '../src/update-checker'

jest.mock('child_process')
jest.mock('../src/logger')
jest.mock('fs')

const mockedExecFile = execFile as unknown as jest.Mock
const mockedExecFileSync = execFileSync as jest.Mock
const mockedSpawn = spawn as jest.Mock
const mockedAccessSync = accessSync as jest.Mock

describe('detectChannelFromVersion', () => {
  it('should detect beta channel', () => {
    expect(detectChannelFromVersion('0.0.4-beta.21')).toBe('beta')
  })

  it('should detect alpha channel', () => {
    expect(detectChannelFromVersion('1.0.0-alpha.3')).toBe('alpha')
  })

  it('should return latest for release version', () => {
    expect(detectChannelFromVersion('0.0.4')).toBe('latest')
  })

  it('should return latest for version without known tag', () => {
    expect(detectChannelFromVersion('1.0.0-rc.1')).toBe('latest')
  })
})

describe('isNewerVersion', () => {
  it('should return true when latest has higher major version', () => {
    expect(isNewerVersion('1.0.0', '2.0.0')).toBe(true)
  })

  it('should return true when latest has higher minor version', () => {
    expect(isNewerVersion('1.0.0', '1.1.0')).toBe(true)
  })

  it('should return true when latest has higher patch version', () => {
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true)
  })

  it('should return false when versions are identical', () => {
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
  })

  it('should return false when current is newer', () => {
    expect(isNewerVersion('2.0.0', '1.0.0')).toBe(false)
  })

  it('should return true when current is pre-release and latest is release', () => {
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0')).toBe(true)
  })

  it('should return false when current is release and latest is pre-release', () => {
    expect(isNewerVersion('1.0.0', '1.0.0-beta.1')).toBe(false)
  })

  it('should compare pre-release versions lexicographically', () => {
    expect(isNewerVersion('1.0.0-alpha.1', '1.0.0-beta.1')).toBe(true)
  })

  it('should return false when pre-release versions are identical', () => {
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0-beta.1')).toBe(false)
  })

  it('should handle major version difference regardless of pre-release', () => {
    expect(isNewerVersion('1.0.0-beta.1', '2.0.0-alpha.1')).toBe(true)
  })

  it('should handle incomplete version strings with missing parts', () => {
    // Triggers ?? 0 fallback for missing minor/patch
    expect(isNewerVersion('1', '2')).toBe(true)
    expect(isNewerVersion('1.0', '1.1')).toBe(true)
  })
})

describe('isValidVersion', () => {
  it('should accept valid semver', () => {
    expect(isValidVersion('1.0.0')).toBe(true)
    expect(isValidVersion('1.2.3')).toBe(true)
    expect(isValidVersion('0.0.1')).toBe(true)
  })

  it('should accept semver with pre-release', () => {
    expect(isValidVersion('1.0.0-beta.1')).toBe(true)
    expect(isValidVersion('1.0.0-alpha.3')).toBe(true)
  })

  it('should reject invalid versions', () => {
    expect(isValidVersion('invalid')).toBe(false)
    expect(isValidVersion('1.0')).toBe(false)
    expect(isValidVersion('')).toBe(false)
  })

  it('should reject versions with trailing arbitrary content', () => {
    expect(isValidVersion('1.0.0; rm -rf /')).toBe(false)
    expect(isValidVersion('1.0.0<script>')).toBe(false)
    expect(isValidVersion('1.0.0 malicious')).toBe(false)
    expect(isValidVersion('1.0.0-')).toBe(false)
  })
})

describe('getGlobalNpmPrefix', () => {
  beforeEach(() => {
    resetGlobalPrefixCache()
    jest.clearAllMocks()
  })

  it('should return trimmed output from npm prefix -g', () => {
    mockedExecFileSync.mockReturnValue('/usr/local\n')

    const result = getGlobalNpmPrefix()

    expect(result).toBe('/usr/local')
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      NPM_COMMAND,
      ['prefix', '-g'],
      { encoding: 'utf-8', timeout: 10_000 },
    )
  })

  it('should cache the result after first call', () => {
    mockedExecFileSync.mockReturnValue('/usr/local\n')

    getGlobalNpmPrefix()
    getGlobalNpmPrefix()

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1)
  })

  it('should throw when npm command fails', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('npm not found')
    })

    expect(() => getGlobalNpmPrefix()).toThrow('npm not found')
  })
})

describe('hasGlobalWritePermission', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    resetGlobalPrefixCache()
    jest.clearAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('should return true when directory is writable', () => {
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)

    expect(hasGlobalWritePermission()).toBe(true)
  })

  it('should return false when directory is not writable', () => {
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })

    expect(hasGlobalWritePermission()).toBe(false)
  })

  it('should return false when npm prefix fails', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('npm not found')
    })

    expect(hasGlobalWritePermission()).toBe(false)
  })

  it('should always return true on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    expect(hasGlobalWritePermission()).toBe(true)
    expect(mockedAccessSync).not.toHaveBeenCalled()
  })
})

describe('isSudoAvailable', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  const originalPlatform = process.platform

  it('should return true when sudo is found', () => {
    mockedExecFileSync.mockReturnValue('/usr/bin/sudo\n')

    expect(isSudoAvailable()).toBe(true)
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'which',
      ['sudo'],
      { encoding: 'utf-8', timeout: 5_000 },
    )
  })

  it('should return false when sudo is not found', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('not found')
    })

    expect(isSudoAvailable()).toBe(false)
  })

  it('should return false on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })

    expect(isSudoAvailable()).toBe(false)
    expect(mockedExecFileSync).not.toHaveBeenCalled()
  })
})

describe('detectInstallMethod', () => {
  const originalArgv = process.argv
  const originalExecArgv = process.execArgv

  beforeEach(() => {
    resetGlobalPrefixCache()
    jest.clearAllMocks()
  })

  afterEach(() => {
    process.argv = originalArgv
    process.execArgv = originalExecArgv
  })

  it('should detect dev mode when execArgv contains ts-node', () => {
    process.execArgv = ['--require', 'ts-node/register']
    process.argv = ['node', '/some/path/index.js']

    expect(detectInstallMethod()).toBe('dev')
  })

  it('should detect dev mode when script ends with .ts', () => {
    process.execArgv = []
    process.argv = ['node', '/some/path/src/index.ts']

    expect(detectInstallMethod()).toBe('dev')
  })

  it('should detect npx when path contains /_npx/', () => {
    process.execArgv = []
    process.argv = ['node', '/Users/test/.npm/_npx/abc123/node_modules/.bin/ai-support-agent']

    expect(detectInstallMethod()).toBe('npx')
  })

  it('should detect npx when path contains \\_npx\\ (Windows)', () => {
    process.execArgv = []
    process.argv = ['node', 'C:\\Users\\test\\.npm\\_npx\\abc123\\node_modules\\.bin\\ai-support-agent']

    expect(detectInstallMethod()).toBe('npx')
  })

  it('should detect global when script is under npm global prefix', () => {
    process.execArgv = []
    process.argv = ['node', '/usr/local/lib/node_modules/@ai-support-agent/cli/dist/index.js']
    mockedExecFileSync.mockReturnValue('/usr/local\n')

    expect(detectInstallMethod()).toBe('global')
  })

  it('should return local as fallback', () => {
    process.execArgv = []
    process.argv = ['node', '/home/user/project/node_modules/.bin/ai-support-agent']
    mockedExecFileSync.mockReturnValue('/usr/local\n')

    expect(detectInstallMethod()).toBe('local')
  })

  it('should return local when npm prefix -g fails', () => {
    process.execArgv = []
    process.argv = ['node', '/some/random/path']
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('npm not found')
    })

    expect(detectInstallMethod()).toBe('local')
  })

  it('should prioritize dev over npx when both indicators present', () => {
    process.execArgv = ['--require', 'ts-node/register']
    process.argv = ['node', '/Users/test/.npm/_npx/abc123/node_modules/.bin/ai-support-agent']

    expect(detectInstallMethod()).toBe('dev')
  })

  it('should handle empty argv[1]', () => {
    process.execArgv = []
    process.argv = ['node']
    mockedExecFileSync.mockReturnValue('/usr/local\n')

    expect(detectInstallMethod()).toBe('local')
  })
})

describe('performUpdate', () => {
  beforeEach(() => {
    resetGlobalPrefixCache()
    jest.clearAllMocks()
  })

  it('should call npm install without sudo when directory is writable', async () => {
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result).toEqual({ success: true })
    expect(mockedExecFile).toHaveBeenCalledWith(
      NPM_COMMAND,
      expect.arrayContaining(['install', '-g', '@ai-support-agent/cli@1.2.3']),
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    )
  })

  it('should use sudo when global directory is not writable and sudo is available', async () => {
    mockedExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') return '/usr/bin/sudo\n'
      return '/usr/local\n'
    })
    mockedAccessSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result).toEqual({ success: true })
    if (process.platform !== 'win32') {
      expect(mockedExecFile).toHaveBeenCalledWith(
        'sudo',
        expect.arrayContaining([NPM_COMMAND, 'install', '-g', '@ai-support-agent/cli@1.2.3']),
        expect.objectContaining({ timeout: 120000 }),
        expect.any(Function),
      )
    }
  })

  it('should not use sudo when global directory is not writable but sudo is unavailable', async () => {
    mockedExecFileSync.mockImplementation((cmd: string) => {
      if (cmd === 'which') throw new Error('not found')
      return '/usr/local\n'
    })
    mockedAccessSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result).toEqual({ success: true })
    expect(mockedExecFile).toHaveBeenCalledWith(
      NPM_COMMAND,
      expect.arrayContaining(['install', '-g', '@ai-support-agent/cli@1.2.3']),
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    )
  })

  it('should call npm install for npx method', async () => {
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    const result = await performUpdate('1.2.3', 'npx')

    expect(result).toEqual({ success: true })
    expect(mockedExecFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['install', '-g', '@ai-support-agent/cli@1.2.3']),
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    )
  })

  it('should auto-detect install method when not provided', async () => {
    // argv pattern for global install
    process.argv = ['node', '/usr/local/lib/node_modules/@ai-support-agent/cli/dist/index.js']
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    // Call without method argument to test ?? branch
    const result = await performUpdate('1.2.3')

    expect(result).toEqual({ success: true })
  })

  it('should return error for dev method', async () => {
    const result = await performUpdate('1.2.3', 'dev')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Development mode')
    expect(mockedExecFile).not.toHaveBeenCalled()
  })

  it('should return error for local method', async () => {
    const result = await performUpdate('1.2.3', 'local')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Local installation')
    expect(mockedExecFile).not.toHaveBeenCalled()
  })

  it('should return failure with error message on general error', async () => {
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
      callback(new Error('npm ERR! 404 Not Found'))
    })

    const result = await performUpdate('99.99.99', 'global')

    expect(result.success).toBe(false)
    expect(result.error).toContain('npm ERR! 404 Not Found')
  })

  it('should append stderr to error.message so the real cause is visible', async () => {
    const error = new Error('Command failed: npm install -g @ai-support-agent/cli@1.2.3')
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
      callback(error, '', 'npm ERR! code ENOTFOUND npm ERR! syscall getaddrinfo')
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Command failed: npm install -g @ai-support-agent/cli@1.2.3')
    expect(result.error).toContain('| stderr: npm ERR! code ENOTFOUND')
    expect(result.error).toContain('npm ERR! syscall getaddrinfo')
  })

  it('should redact bearer tokens and basic-auth URLs from forwarded stderr', async () => {
    const error = new Error('Command failed: npm install -g @ai-support-agent/cli@1.2.3')
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
      callback(
        error,
        '',
        'npm ERR! Bearer ey1234567890abcdef _authToken=npm_supersecret https://u:p@registry.npmjs.org/foo',
      )
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result.success).toBe(false)
    expect(result.error).not.toContain('ey1234567890abcdef')
    expect(result.error).not.toContain('npm_supersecret')
    expect(result.error).not.toContain('u:p@registry.npmjs.org')
    expect(result.error).toContain('Bearer ***REDACTED***')
    expect(result.error).toContain('_authToken=***REDACTED***')
    expect(result.error).toContain('***REDACTED***@registry.npmjs.org')
  })

  it('should fall back to Unknown error when both error.message and stderr are empty', async () => {
    const error = new Error('')
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
      callback(error, '', '')
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Unknown error')
  })

  it('should use NPM_COMMAND (platform-specific npm binary) for install', async () => {
    // NPM_COMMAND is evaluated at module load time and reflects the current platform.
    // The platform-specific selection (npm vs npm.cmd) is tested in constants.spec.ts.
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result).toEqual({ success: true })
    expect(mockedExecFile).toHaveBeenCalledWith(
      NPM_COMMAND,
      expect.arrayContaining(['install', '-g', '@ai-support-agent/cli@1.2.3']),
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    )
  })

  it('should use a per-project npm cache dir when cacheScope is provided', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    await performUpdate('1.2.3', 'global', 'mbc-MBC_CQRS_SERVERLESS')

    const args = mockedExecFile.mock.calls[0][1] as string[]
    const cacheIdx = args.indexOf('--cache')
    expect(cacheIdx).toBeGreaterThanOrEqual(0)
    expect(args[cacheIdx + 1]).toMatch(/[/\\]\.npm-update-cache-mbc-MBC_CQRS_SERVERLESS$/)
  })

  it('should sanitize cacheScope to a path-safe form', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    await performUpdate('1.2.3', 'global', '../etc/passwd')

    const args = mockedExecFile.mock.calls[0][1] as string[]
    const cacheIdx = args.indexOf('--cache')
    expect(args[cacheIdx + 1]).toMatch(/[/\\]\.npm-update-cache-___etc_passwd$/)
  })

  it('should default to the shared cache dir when cacheScope is omitted', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    await performUpdate('1.2.3', 'global')

    const args = mockedExecFile.mock.calls[0][1] as string[]
    const cacheIdx = args.indexOf('--cache')
    expect(args[cacheIdx + 1]).toMatch(/[/\\]\.npm-update-cache$/)
  })

  it('should truncate an oversize cacheScope to bound path length', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    mockedExecFileSync.mockReturnValue('/usr/local\n')
    mockedAccessSync.mockImplementation(() => undefined)
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    const longScope = 'A'.repeat(200)
    await performUpdate('1.2.3', 'global', longScope)

    const args = mockedExecFile.mock.calls[0][1] as string[]
    const cacheIdx = args.indexOf('--cache')
    const dir = args[cacheIdx + 1] as string
    const basename = dir.split(/[/\\]/).pop()!
    expect(basename.length).toBeLessThanOrEqual('.npm-update-cache-'.length + 64)
    expect(basename.startsWith('.npm-update-cache-')).toBe(true)
  })
})

describe('redactSecrets', () => {
  it('should redact Bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer eyJabc.def123-XYZ')).toBe(
      'Authorization: Bearer ***REDACTED***',
    )
  })

  it('should redact npm _authToken and authToken values', () => {
    expect(redactSecrets('_authToken=npm_secret_abc.123')).toBe('_authToken=***REDACTED***')
    expect(redactSecrets('authToken : "abc.def.ghi"')).toBe('authToken : "***REDACTED***"')
  })

  it('should redact X-Auth-Token headers', () => {
    expect(redactSecrets('X-Auth-Token: token-xyz-7890')).toBe('X-Auth-Token: ***REDACTED***')
  })

  it('should redact basic-auth credentials in URLs', () => {
    expect(redactSecrets('https://user:hunter2@registry.npmjs.org/foo')).toBe(
      'https://***REDACTED***@registry.npmjs.org/foo',
    )
  })

  it('should leave non-secret text unchanged', () => {
    const input = 'npm ERR! code E401\nnpm ERR! 401 Unauthorized'
    expect(redactSecrets(input)).toBe(input)
  })
})

describe('reExecProcess', () => {
  const originalArgv = process.argv
  const originalExecArgv = process.execArgv
  let exitSpy: jest.SpiedFunction<typeof process.exit>

  beforeEach(() => {
    jest.clearAllMocks()
    resetGlobalPrefixCache()
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    mockedSpawn.mockReturnValue({ unref: jest.fn() })
  })

  afterEach(() => {
    exitSpy.mockRestore()
    process.argv = originalArgv
    process.execArgv = originalExecArgv
  })

  it('should include process.execArgv in spawned args for global method', () => {
    process.execArgv = ['--env-file-if-exists=.env']
    process.argv = ['node', '/usr/local/lib/node_modules/@ai-support-agent/cli/dist/index.js', 'start']

    reExecProcess('global')

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['--env-file-if-exists=.env', '/usr/local/lib/node_modules/@ai-support-agent/cli/dist/index.js', 'start'],
      expect.objectContaining({ detached: true, stdio: 'inherit', env: expect.any(Object) }),
    )
  })

  it('should pass environment variables via env option', () => {
    process.execArgv = []
    process.argv = ['node', '/some/path/index.js']

    reExecProcess('global')

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      expect.any(Array),
      expect.objectContaining({ env: expect.any(Object) }),
    )
  })

  it('should resolve global binary script for npx method', () => {
    process.execArgv = []
    process.argv = ['node', '/Users/test/.npm/_npx/abc123/node_modules/.bin/ai-support-agent', 'start', '--verbose']
    mockedExecFileSync.mockReturnValue('/usr/local\n')

    reExecProcess('npx')

    const expectedScript = process.platform === 'win32'
      ? expect.stringContaining('node_modules')
      : expect.stringContaining('/usr/local/lib/node_modules/@ai-support-agent/cli/dist/index.js')

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([expectedScript, 'start', '--verbose']),
      expect.objectContaining({ detached: true, stdio: 'inherit' }),
    )
  })

  it('should resolve Windows global binary script for npx method', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.execArgv = []
    process.argv = ['node', 'C:\\Users\\test\\.npm\\_npx\\abc123\\node_modules\\.bin\\ai-support-agent', 'start']
    mockedExecFileSync.mockReturnValue('C:\\Users\\test\\AppData\\Roaming\\npm\n')

    reExecProcess('npx')

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([
        expect.stringContaining('node_modules'),
        'start',
      ]),
      expect.objectContaining({ detached: true, stdio: 'inherit' }),
    )
  })

  it('should preserve argv for local method', () => {
    process.execArgv = []
    process.argv = ['node', '/home/user/project/node_modules/.bin/ai-support-agent', 'start']

    reExecProcess('local')

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['/home/user/project/node_modules/.bin/ai-support-agent', 'start'],
      expect.objectContaining({ detached: true, stdio: 'inherit' }),
    )
  })

  it('should preserve execArgv for dev method', () => {
    process.execArgv = ['--require', 'ts-node/register', '--env-file-if-exists=.env']
    process.argv = ['node', '/home/user/project/src/index.ts', 'start']

    reExecProcess('dev')

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['--require', 'ts-node/register', '--env-file-if-exists=.env', '/home/user/project/src/index.ts', 'start'],
      expect.objectContaining({ detached: true, stdio: 'inherit' }),
    )
  })

  it('should unref the child process and exit', () => {
    const mockUnref = jest.fn()
    mockedSpawn.mockReturnValue({ unref: mockUnref })

    reExecProcess('global')

    expect(mockUnref).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})

describe('reExecProcess: method=undefined → detectInstallMethod()（line 216 branch [1]）', () => {
  let exitSpy: jest.SpiedFunction<typeof process.exit>
  const originalArgv = process.argv

  beforeEach(() => {
    jest.clearAllMocks()
    resetGlobalPrefixCache()
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    mockedSpawn.mockReturnValue({ unref: jest.fn() })
  })

  afterEach(() => {
    exitSpy.mockRestore()
    process.argv = originalArgv
  })

  it('method が undefined の場合 detectInstallMethod() で自動検出する（line 216 branch [1]）', () => {
    // Cover: const installMethod = method ?? detectInstallMethod()
    // When method is not provided (undefined), detectInstallMethod() is called
    process.argv = ['/usr/local/bin/node', '/usr/local/bin/ai-support-agent', 'start']

    // Call without method argument → method=undefined → ?? detectInstallMethod()
    reExecProcess()

    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
