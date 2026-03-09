import { execFile, execFileSync, spawn } from 'child_process'

import {
  detectChannelFromVersion,
  detectInstallMethod,
  getGlobalNpmPrefix,
  isNewerVersion,
  isValidVersion,
  performUpdate,
  reExecProcess,
  resetGlobalPrefixCache,
} from '../src/update-checker'

jest.mock('child_process')
jest.mock('../src/logger')

const mockedExecFile = execFile as unknown as jest.Mock
const mockedExecFileSync = execFileSync as jest.Mock
const mockedSpawn = spawn as jest.Mock

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
    const expectedCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      expectedCmd,
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
    jest.clearAllMocks()
  })

  it('should call npm install with correct arguments for global method', async () => {
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result).toEqual({ success: true })
    const expectedCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    expect(mockedExecFile).toHaveBeenCalledWith(
      expectedCmd,
      ['install', '-g', '@ai-support-agent/cli@1.2.3'],
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    )
  })

  it('should call npm install for npx method', async () => {
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    const result = await performUpdate('1.2.3', 'npx')

    expect(result).toEqual({ success: true })
    expect(mockedExecFile).toHaveBeenCalledWith(
      expect.any(String),
      ['install', '-g', '@ai-support-agent/cli@1.2.3'],
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    )
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
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
      callback(new Error('npm ERR! 404 Not Found'))
    })

    const result = await performUpdate('99.99.99', 'global')

    expect(result.success).toBe(false)
    expect(result.error).toContain('npm ERR! 404 Not Found')
  })

  it('should fallback to stderr when error.message is empty', async () => {
    const error = new Error('')
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
      callback(error, '', 'stderr output here')
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result.success).toBe(false)
    expect(result.error).toBe('stderr output here')
  })

  it('should detect EACCES permission errors', async () => {
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
      callback(new Error('EACCES: permission denied'))
    })

    const result = await performUpdate('1.2.3', 'global')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Permission denied')
    expect(result.error).toContain('sudo')
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
