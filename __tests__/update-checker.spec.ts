import { execFile, spawn } from 'child_process'

import { isNewerVersion, isValidVersion, performUpdate, reExecProcess } from '../src/update-checker'

jest.mock('child_process')
jest.mock('../src/logger')

const mockedExecFile = execFile as unknown as jest.Mock
const mockedSpawn = spawn as jest.Mock

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

describe('performUpdate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('should call npm install with correct arguments', async () => {
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
      callback(null)
    })

    const result = await performUpdate('1.2.3')

    expect(result).toEqual({ success: true })
    const expectedCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    expect(mockedExecFile).toHaveBeenCalledWith(
      expectedCmd,
      ['install', '-g', '@ai-support-agent/cli@1.2.3'],
      expect.objectContaining({ timeout: 120000 }),
      expect.any(Function),
    )
  })

  it('should return failure with error message on general error', async () => {
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
      callback(new Error('npm ERR! 404 Not Found'))
    })

    const result = await performUpdate('99.99.99')

    expect(result.success).toBe(false)
    expect(result.error).toContain('npm ERR! 404 Not Found')
  })

  it('should fallback to stderr when error.message is empty', async () => {
    const error = new Error('')
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error, stdout: string, stderr: string) => void) => {
      callback(error, '', 'stderr output here')
    })

    const result = await performUpdate('1.2.3')

    expect(result.success).toBe(false)
    expect(result.error).toBe('stderr output here')
  })

  it('should detect EACCES permission errors', async () => {
    mockedExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
      callback(new Error('EACCES: permission denied'))
    })

    const result = await performUpdate('1.2.3')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Permission denied')
    expect(result.error).toContain('sudo')
  })
})

describe('reExecProcess', () => {
  let exitSpy: jest.SpiedFunction<typeof process.exit>

  beforeEach(() => {
    jest.clearAllMocks()
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    mockedSpawn.mockReturnValue({ unref: jest.fn() })
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  it('should spawn a detached process with correct arguments', () => {
    reExecProcess()

    expect(mockedSpawn).toHaveBeenCalledWith(
      process.execPath,
      process.argv.slice(1),
      { detached: true, stdio: 'inherit' },
    )
  })

  it('should unref the child process and exit', () => {
    const mockUnref = jest.fn()
    mockedSpawn.mockReturnValue({ unref: mockUnref })

    reExecProcess()

    expect(mockUnref).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
  })
})
