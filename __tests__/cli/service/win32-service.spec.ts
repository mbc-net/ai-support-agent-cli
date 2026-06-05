jest.mock('fs')
jest.mock('child_process')
jest.mock('../../../src/logger')
jest.mock('../../../src/i18n', () => ({
  initI18n: jest.fn(),
  t: (key: string, params?: Record<string, unknown>) => {
    if (params) {
      let result = key
      for (const [k, v] of Object.entries(params)) {
        result = result.replace(`{{${k}}}`, String(v))
      }
      return result
    }
    return key
  },
}))

jest.mock('../../../src/config-manager', () => ({
  loadConfig: jest.fn(),
  getProjectList: jest.fn(),
  getConfigDir: jest.fn(() =>
    require('path').join(require('os').homedir(), '.ai-support-agent'),
  ),
}))

import { execSync } from 'child_process'
import * as fs from 'fs'
import {
  Win32ServiceStrategy,
  generateTaskXml,
  generateProjectTaskXml,
  generateWin32WrapperScript,
  getProjectTaskName,
  getAllProjectTasks,
  writeAndRegisterProjectTask,
  getCliEntryPoint,
  getNodePath,
} from '../../../src/cli/service/win32-service'
import { logger } from '../../../src/logger'
import { loadConfig, getProjectList } from '../../../src/config-manager'
import type { ProjectRegistration } from '../../../src/types'

const mockedFs = jest.mocked(fs)
const mockedExecSync = jest.mocked(execSync)
const mockedLoadConfig = jest.mocked(loadConfig)
const mockedGetProjectList = jest.mocked(getProjectList)

const sampleProject: ProjectRegistration = {
  tenantCode: 'mbc',
  projectCode: 'MBC_01',
  token: 'test-token',
  apiUrl: 'https://api.example.com',
} as ProjectRegistration

beforeEach(() => {
  jest.clearAllMocks()
  mockedLoadConfig.mockReturnValue({} as never)
  mockedGetProjectList.mockReturnValue([sampleProject])
})

describe('re-exports', () => {
  it('re-exports getCliEntryPoint and getNodePath as functions', () => {
    expect(typeof getCliEntryPoint).toBe('function')
    expect(typeof getNodePath).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// getProjectTaskName
// ---------------------------------------------------------------------------
describe('getProjectTaskName', () => {
  it('builds a sanitized, lowercase task name', () => {
    expect(getProjectTaskName('MBC', 'MBC_01')).toBe('AISupportAgent-mbc-mbc-01')
  })

  it('replaces non-alphanumeric characters (incl. backslash) with hyphens', () => {
    expect(getProjectTaskName('my_tenant', 'MY\\PROJ')).toBe('AISupportAgent-my-tenant-my-proj')
  })
})

// ---------------------------------------------------------------------------
// generateProjectTaskXml
// ---------------------------------------------------------------------------
describe('generateProjectTaskXml', () => {
  it('runs cmd.exe on the wrapper script and sets a logon trigger', () => {
    const xml = generateProjectTaskXml({ wrapperScriptPath: 'C:\\svc\\run.cmd' })
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-16"?>')
    expect(xml).toContain('<LogonTrigger>')
    expect(xml).toContain('<Command>cmd.exe</Command>')
    expect(xml).toContain('/c &quot;C:\\svc\\run.cmd&quot;')
  })
})

// ---------------------------------------------------------------------------
// generateWin32WrapperScript
// ---------------------------------------------------------------------------
describe('generateWin32WrapperScript', () => {
  const baseOpts = {
    imageName: 'ai-support-agent',
    tenantCode: 'mbc',
    projectCode: 'MBC_01',
    projectConfigHostDir: 'C:\\Users\\test\\.ai-support-agent\\projects\\mbc\\MBC_01\\.ai-support-agent',
    token: 'test-token',
    apiUrl: 'https://api.example.com',
  }

  it('generates a batch wrapper with docker run and the resolved image tag', () => {
    const result = generateWin32WrapperScript(baseOpts)
    expect(result).toContain('@echo off')
    expect(result).toContain('docker run --rm -i --name "ai-mbc-mbc-01"')
    expect(result).toContain('set "IMAGE_TAG=ai-support-agent:%_INSTALLED_VERSION%"')
    expect(result).toContain('"%IMAGE_TAG%"')
    expect(result).toContain('ai-support-agent start --no-docker')
    expect(result).toContain('--project mbc/MBC_01')
  })

  it('sets secrets via `set` and passes them by name (not on the command line)', () => {
    const result = generateWin32WrapperScript(baseOpts)
    expect(result).toContain('set "AI_SUPPORT_AGENT_TOKEN=test-token"')
    expect(result).toContain('-e AI_SUPPORT_AGENT_TOKEN ^')
    // The token value must not appear on the `-e` line itself.
    expect(result).not.toContain('-e AI_SUPPORT_AGENT_TOKEN=test-token')
  })

  it('converts localhost API URL to host.docker.internal', () => {
    const result = generateWin32WrapperScript({ ...baseOpts, apiUrl: 'http://localhost:4030' })
    expect(result).toContain('set "AI_SUPPORT_AGENT_API_URL=http://host.docker.internal:4030"')
    expect(result).not.toContain('localhost')
  })

  it('includes ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN when provided', () => {
    const result = generateWin32WrapperScript({
      ...baseOpts,
      anthropicApiKey: 'sk-ant-test',
      claudeCodeOauthToken: 'oauth-tok',
    })
    expect(result).toContain('set "ANTHROPIC_API_KEY=sk-ant-test"')
    expect(result).toContain('set "CLAUDE_CODE_OAUTH_TOKEN=oauth-tok"')
    expect(result).toContain('-e ANTHROPIC_API_KEY ^')
    expect(result).toContain('-e CLAUDE_CODE_OAUTH_TOKEN ^')
  })

  it('adds --verbose when requested', () => {
    const result = generateWin32WrapperScript({ ...baseOpts, verbose: true })
    expect(result).toContain('--verbose')
  })

  it('rejects a token containing cmd metacharacters', () => {
    expect(() => generateWin32WrapperScript({ ...baseOpts, token: 'tok%PATH%' })).toThrow(/invalidWin32Value/)
    expect(() => generateWin32WrapperScript({ ...baseOpts, token: 'tok!x' })).toThrow(/invalidWin32Value/)
    expect(() => generateWin32WrapperScript({ ...baseOpts, token: 'tok&calc' })).toThrow(/invalidWin32Value/)
  })

  it('rejects a token containing parentheses', () => {
    expect(() => generateWin32WrapperScript({ ...baseOpts, token: 'tok(x)' })).toThrow(/invalidWin32Value/)
  })

  it('rejects a token with leading or trailing whitespace', () => {
    expect(() => generateWin32WrapperScript({ ...baseOpts, token: ' tok' })).toThrow(/invalidWin32Value/)
    expect(() => generateWin32WrapperScript({ ...baseOpts, token: 'tok ' })).toThrow(/invalidWin32Value/)
  })

  it('rejects an unsafe projectCode', () => {
    expect(() => generateWin32WrapperScript({ ...baseOpts, projectCode: 'BAD;CODE' })).toThrow(/invalidProjectCode/)
  })

  it('uses for /f usebackq so inner quotes do not break parsing', () => {
    const result = generateWin32WrapperScript(baseOpts)
    expect(result).toContain('for /f "usebackq delims="')
    // The version-resolution command keeps its double-quoted node -p argument.
    expect(result).toContain('node -p "require(')
  })
})

// ---------------------------------------------------------------------------
// getAllProjectTasks
// ---------------------------------------------------------------------------
describe('getAllProjectTasks', () => {
  it('extracts project task names from schtasks CSV output', () => {
    mockedExecSync.mockReturnValue(
      Buffer.from(
        '"\\AISupportAgent-mbc-mbc-01","Ready"\r\n' +
        '"\\AISupportAgent-mbc-mbc-02","Running"\r\n' +
        '"\\SomeOtherTask","Ready"\r\n',
      ),
    )
    const tasks = getAllProjectTasks()
    expect(tasks).toEqual([
      { taskName: 'AISupportAgent-mbc-mbc-01' },
      { taskName: 'AISupportAgent-mbc-mbc-02' },
    ])
  })

  it('returns an empty list when schtasks fails', () => {
    mockedExecSync.mockImplementation(() => { throw new Error('schtasks missing') })
    expect(getAllProjectTasks()).toEqual([])
  })

  it('deduplicates repeated rows', () => {
    mockedExecSync.mockReturnValue(
      Buffer.from('"\\AISupportAgent-mbc-mbc-01","Ready"\r\n"\\AISupportAgent-mbc-mbc-01","Ready"\r\n'),
    )
    expect(getAllProjectTasks()).toEqual([{ taskName: 'AISupportAgent-mbc-mbc-01' }])
  })
})

// ---------------------------------------------------------------------------
// writeAndRegisterProjectTask
// ---------------------------------------------------------------------------
describe('writeAndRegisterProjectTask', () => {
  it('writes the wrapper, registers the task, and cleans up the tmp XML', () => {
    mockedFs.existsSync.mockReturnValue(true)
    mockedExecSync.mockReturnValue(Buffer.from(''))

    writeAndRegisterProjectTask(sampleProject)

    // run.cmd + (tmp xml is also written) → at least the wrapper write happened
    const cmdWrite = mockedFs.writeFileSync.mock.calls.find(([p]) => String(p).endsWith('run.cmd'))
    expect(cmdWrite).toBeDefined()
    // The wrapper holds the token in plaintext → must be written owner-only.
    expect(cmdWrite?.[2]).toMatchObject({ mode: 0o700 })

    expect(mockedExecSync).toHaveBeenCalledWith(
      expect.stringContaining('schtasks /Create /TN "AISupportAgent-mbc-mbc-01" /XML'),
      { stdio: 'pipe' },
    )
    expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('AISupportAgent-mbc-mbc-01-task.xml'),
    )
  })

  it('creates missing directories', () => {
    mockedFs.existsSync.mockReturnValue(false)
    mockedExecSync.mockReturnValue(Buffer.from(''))

    writeAndRegisterProjectTask(sampleProject)

    expect(mockedFs.mkdirSync).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Win32ServiceStrategy
// ---------------------------------------------------------------------------
describe('Win32ServiceStrategy', () => {
  const strategy = new Win32ServiceStrategy()

  describe('install', () => {
    it('errors when no projects are configured', () => {
      mockedGetProjectList.mockReturnValue([])
      strategy.install({})
      expect(logger.error).toHaveBeenCalledWith('service.noProjectsConfigured')
    })

    it('errors when the entry point does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)
      strategy.install({})
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.entryPointNotFound'),
      )
    })

    it('registers a per-project task and reports success', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.install({})

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('schtasks /Create /TN "AISupportAgent-mbc-mbc-01" /XML'),
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith(
        expect.stringContaining('service.projectInstalled'),
      )
    })

    it('creates the log directory when it does not exist', () => {
      // entry point exists (true), log dir missing (false), everything else true
      mockedFs.existsSync.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.install({})

      const localAppData = process.env.LOCALAPPDATA || require('path').join(require('os').homedir(), 'AppData', 'Local')
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        require('path').join(localAppData, 'ai-support-agent', 'logs'),
        { recursive: true },
      )
    })

    it('reports a collision and skips the colliding project', () => {
      // MBC_01 and MBC-01 both sanitize to the same task name.
      mockedGetProjectList.mockReturnValue([
        sampleProject,
        { ...sampleProject, projectCode: 'MBC-01' } as ProjectRegistration,
      ])
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectUnitNameCollision'),
      )
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('service.partialInstallSummary'),
      )
    })

    it('continues past a per-project failure', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockImplementation(() => { throw new Error('schtasks denied') })

      strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.projectInstallFailed'),
      )
    })
  })

  describe('uninstall', () => {
    it('warns when no tasks are installed', () => {
      mockedExecSync.mockReturnValue(Buffer.from('')) // query returns nothing matching
      strategy.uninstall()
      expect(logger.warn).toHaveBeenCalledWith('service.notInstalled.win32')
    })

    it('deletes every project task', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('"\\AISupportAgent-mbc-mbc-01","Ready"\r\n')) // getAllProjectTasks
        .mockReturnValue(Buffer.from('')) // delete
      strategy.uninstall()
      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /Delete /TN "AISupportAgent-mbc-mbc-01" /F',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.uninstalled.win32')
    })

    it('logs an error when delete fails', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('"\\AISupportAgent-mbc-mbc-01","Ready"\r\n'))
        .mockImplementationOnce(() => { throw new Error('denied') })
      strategy.uninstall()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.schtasksFailed'),
      )
    })
  })

  describe('start / stop / restart', () => {
    const queryRow = Buffer.from('"\\AISupportAgent-mbc-mbc-01","Ready"\r\n')

    it('start: errors when nothing is installed', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))
      strategy.start()
      expect(logger.error).toHaveBeenCalledWith('service.notInstalled.win32')
    })

    it('start: runs each task', () => {
      mockedExecSync.mockReturnValueOnce(queryRow).mockReturnValue(Buffer.from(''))
      strategy.start()
      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /Run /TN "AISupportAgent-mbc-mbc-01"',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.started')
    })

    it('start: logs error when Run fails', () => {
      mockedExecSync
        .mockReturnValueOnce(queryRow)
        .mockImplementationOnce(() => { throw new Error('run failed') })
      strategy.start()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.startFailed'),
      )
    })

    it('stop: ends each task', () => {
      mockedExecSync.mockReturnValueOnce(queryRow).mockReturnValue(Buffer.from(''))
      strategy.stop()
      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /End /TN "AISupportAgent-mbc-mbc-01"',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.stopped')
    })

    it('stop: errors when nothing is installed', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))
      strategy.stop()
      expect(logger.error).toHaveBeenCalledWith('service.notInstalled.win32')
    })

    it('stop: logs error when End fails', () => {
      mockedExecSync
        .mockReturnValueOnce(queryRow)
        .mockImplementationOnce(() => { throw new Error('end failed') })
      strategy.stop()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.stopFailed'),
      )
    })

    it('restart: errors when nothing is installed', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))
      strategy.restart()
      expect(logger.error).toHaveBeenCalledWith('service.notInstalled.win32')
    })

    it('restart: ends then runs each task', () => {
      mockedExecSync.mockReturnValueOnce(queryRow).mockReturnValue(Buffer.from(''))
      strategy.restart()
      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /Run /TN "AISupportAgent-mbc-mbc-01"',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('restart: tolerates End failing (task not running)', () => {
      mockedExecSync
        .mockReturnValueOnce(queryRow)
        .mockImplementationOnce(() => { throw new Error('not running') }) // End
        .mockReturnValue(Buffer.from('')) // Run
      strategy.restart()
      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('restart: logs error when Run fails', () => {
      mockedExecSync
        .mockReturnValueOnce(queryRow)
        .mockReturnValueOnce(Buffer.from('')) // End
        .mockImplementationOnce(() => { throw new Error('run failed') }) // Run
      strategy.restart()
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.restartFailed'),
      )
    })
  })

  describe('status', () => {
    it('returns not installed when there are no tasks', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))
      expect(strategy.status()).toEqual({ installed: false, running: false })
    })

    it('returns running when a task is Running', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('"\\AISupportAgent-mbc-mbc-01","Running"\r\n')) // getAllProjectTasks
        .mockReturnValue(Buffer.from('"AISupportAgent-mbc-mbc-01","Running"')) // per-task query
      const result = strategy.status()
      expect(result.installed).toBe(true)
      expect(result.running).toBe(true)
      expect(result.projects?.[0]).toMatchObject({ projectCode: 'MBC_01', running: true })
    })

    it('marks a task not running when its query is Ready', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('"\\AISupportAgent-mbc-mbc-01","Ready"\r\n'))
        .mockReturnValue(Buffer.from('"AISupportAgent-mbc-mbc-01","Ready"'))
      const result = strategy.status()
      expect(result.running).toBe(false)
      expect(result.projects?.[0]).toMatchObject({ running: false })
    })

    it('treats a failing per-task query as not running', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('"\\AISupportAgent-mbc-mbc-01","Ready"\r\n'))
        .mockImplementationOnce(() => { throw new Error('query failed') })
      const result = strategy.status()
      expect(result.installed).toBe(true)
      expect(result.running).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// generateTaskXml (legacy single-task form, kept for back-compat)
// ---------------------------------------------------------------------------
describe('generateTaskXml (legacy)', () => {
  it('generates valid single-task XML', () => {
    const result = generateTaskXml({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      entryPoint: 'C:\\cli\\dist\\index.js',
      logDir: 'C:\\logs',
    })
    expect(result).toContain('<?xml version="1.0" encoding="UTF-16"?>')
    expect(result).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>')
    expect(result).toContain('start --no-docker')
    expect(result).not.toContain('--verbose')
  })

  it('includes --verbose and omits --no-docker per options', () => {
    const result = generateTaskXml({
      nodePath: 'C:\\node.exe',
      entryPoint: 'C:\\index.js',
      logDir: 'C:\\logs',
      verbose: true,
      docker: true,
    })
    expect(result).toContain('--verbose')
    expect(result).not.toContain('--no-docker')
  })

  it('escapes XML special characters', () => {
    const result = generateTaskXml({
      nodePath: 'C:\\p <a> & "b"\\node.exe',
      entryPoint: 'C:\\index.js',
      logDir: 'C:\\logs',
    })
    expect(result).toContain('&lt;a&gt;')
    expect(result).toContain('&amp;')
    expect(result).toContain('&quot;b&quot;')
  })
})
