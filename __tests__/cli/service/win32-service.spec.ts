import * as os from 'os'
import * as path from 'path'

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

import { execSync } from 'child_process'
import * as fs from 'fs'
import {
  Win32ServiceStrategy,
  generateTaskXml,
} from '../../../src/cli/service/win32-service'
import { logger } from '../../../src/logger'

const mockedFs = jest.mocked(fs)
const mockedExecSync = jest.mocked(execSync)

describe('generateTaskXml', () => {
  it('should generate valid Task Scheduler XML', () => {
    const result = generateTaskXml({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      entryPoint: 'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@ai-support-agent\\cli\\dist\\index.js',
      logDir: 'C:\\Users\\test\\AppData\\Local\\ai-support-agent\\logs',
    })

    expect(result).toContain('<?xml version="1.0" encoding="UTF-16"?>')
    expect(result).toContain('<Task version="1.2"')
    expect(result).toContain('<LogonTrigger>')
    expect(result).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>')
    expect(result).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(result).toContain('<RestartOnFailure>')
    expect(result).toContain('<Command>C:\\Program Files\\nodejs\\node.exe</Command>')
    expect(result).toContain('start --no-docker')
    expect(result).not.toContain('--verbose')
  })

  it('should include --verbose flag when verbose is true', () => {
    const result = generateTaskXml({
      nodePath: 'C:\\node.exe',
      entryPoint: 'C:\\index.js',
      logDir: 'C:\\logs',
      verbose: true,
    })

    expect(result).toContain('--verbose')
  })

  it('should not include --no-docker when docker is true', () => {
    const result = generateTaskXml({
      nodePath: 'C:\\node.exe',
      entryPoint: 'C:\\index.js',
      logDir: 'C:\\logs',
      docker: true,
    })

    expect(result).not.toContain('--no-docker')
  })

  it('should escape XML special characters', () => {
    const result = generateTaskXml({
      nodePath: 'C:\\path with <special> & "chars"\\node.exe',
      entryPoint: 'C:\\index.js',
      logDir: 'C:\\logs',
    })

    expect(result).toContain('&lt;special&gt;')
    expect(result).toContain('&amp;')
    expect(result).toContain('&quot;chars&quot;')
  })
})

describe('Win32ServiceStrategy', () => {
  const strategy = new Win32ServiceStrategy()

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('install', () => {
    it('should reject if entry point does not exist', () => {
      mockedFs.existsSync.mockReturnValue(false)

      strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.entryPointNotFound'),
      )
    })

    it('should create scheduled task via schtasks', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(true)  // log dir
        .mockReturnValueOnce(true)  // tmp xml cleanup check

      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.install({})

      expect(mockedFs.writeFileSync).toHaveBeenCalledTimes(1)
      const [writtenPath] = mockedFs.writeFileSync.mock.calls[0] as [string, string, string]
      expect(writtenPath).toContain('AISupportAgent-task.xml')

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('schtasks /Create /TN "AISupportAgent"'),
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalled()
    })

    it('should create log directory if it does not exist', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(false) // log dir
        .mockReturnValueOnce(true)  // tmp xml cleanup check

      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.install({})

      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join(localAppData, 'ai-support-agent', 'logs'),
        { recursive: true },
      )
    })

    it('should handle schtasks failure', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true)  // entry point
        .mockReturnValueOnce(true)  // log dir
        .mockReturnValueOnce(true)  // tmp xml cleanup check

      mockedExecSync.mockImplementation(() => {
        throw new Error('Access denied')
      })

      strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.schtasksFailed'),
      )
      expect(logger.success).not.toHaveBeenCalled()
    })

    it('should handle non-Error throw from schtasks', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true) // entry point
        .mockReturnValueOnce(true) // log dir
        .mockReturnValueOnce(false) // tmp xml cleanup (does not exist)

      mockedExecSync.mockImplementation(() => {
        throw 'string error'
      })

      strategy.install({})

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.schtasksFailed'),
      )
    })

    it('should skip tmp XML cleanup if file does not exist', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true) // entry point
        .mockReturnValueOnce(true) // log dir
        .mockReturnValueOnce(false) // tmp xml cleanup check

      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.install({})

      expect(mockedFs.unlinkSync).not.toHaveBeenCalled()
    })

    it('should clean up temporary XML file after install', () => {
      mockedFs.existsSync
        .mockReturnValueOnce(true) // entry point
        .mockReturnValueOnce(true) // log dir
        .mockReturnValueOnce(true) // tmp xml cleanup check

      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.install({})

      // unlinkSync should be called for tmp XML cleanup
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('AISupportAgent-task.xml'),
      )
    })

    it('should pass verbose option to XML generation', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.install({ verbose: true })

      const content = mockedFs.writeFileSync.mock.calls[0]?.[1] as string
      expect(content).toContain('--verbose')
    })
  })

  describe('uninstall', () => {
    it('should warn if task does not exist', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('ERROR: The system cannot find the file specified.')
      })

      strategy.uninstall()

      expect(logger.warn).toHaveBeenCalledWith('service.notInstalled.win32')
    })

    it('should delete task when it exists', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.uninstall()

      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /Query /TN "AISupportAgent"',
        { stdio: 'pipe' },
      )
      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /Delete /TN "AISupportAgent" /F',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalled()
    })

    it('should show unload hint before deleting task', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.uninstall()

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('service.unloadHint.win32'),
      )
    })

    it('should handle schtasks delete failure', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('')) // Query succeeds
        .mockImplementationOnce(() => {
          throw new Error('Access denied')
        })

      strategy.uninstall()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.schtasksFailed'),
      )
      expect(logger.success).not.toHaveBeenCalled()
    })

    it('should handle non-Error throw from schtasks delete', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from('')) // Query succeeds
        .mockImplementationOnce(() => {
          throw 'string delete error'
        })

      strategy.uninstall()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.schtasksFailed'),
      )
    })
  })

  describe('start', () => {
    it('should error if task does not exist', () => {
      mockedExecSync.mockImplementation(() => { throw new Error('not found') })

      strategy.start()

      expect(logger.error).toHaveBeenCalledWith('service.notInstalled.win32')
    })

    it('should run the task', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.start()

      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /Run /TN "AISupportAgent"',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.started')
    })

    it('should log error if Run fails', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))  // Query
        .mockImplementationOnce(() => { throw new Error('run failed') })  // Run

      strategy.start()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.startFailed'),
      )
    })

    it('should handle non-Error throw from start', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))  // Query
        .mockImplementationOnce(() => { throw 'string start error' })  // Run

      strategy.start()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.startFailed'),
      )
    })
  })

  describe('stop', () => {
    it('should error if task does not exist', () => {
      mockedExecSync.mockImplementation(() => { throw new Error('not found') })

      strategy.stop()

      expect(logger.error).toHaveBeenCalledWith('service.notInstalled.win32')
    })

    it('should end the task', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.stop()

      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /End /TN "AISupportAgent"',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.stopped')
    })

    it('should log error if End fails', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))  // Query
        .mockImplementationOnce(() => { throw new Error('end failed') })  // End

      strategy.stop()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.stopFailed'),
      )
    })

    it('should handle non-Error throw from stop', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))  // Query
        .mockImplementationOnce(() => { throw 'string stop error' })  // End

      strategy.stop()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.stopFailed'),
      )
    })
  })

  describe('restart', () => {
    it('should error if task does not exist', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('not found')
      })

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith('service.notInstalled.win32')
    })

    it('should end and run the task', () => {
      mockedExecSync.mockReturnValue(Buffer.from(''))

      strategy.restart()

      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /Query /TN "AISupportAgent"',
        { stdio: 'pipe' },
      )
      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /End /TN "AISupportAgent"',
        { stdio: 'pipe' },
      )
      expect(mockedExecSync).toHaveBeenCalledWith(
        'schtasks /Run /TN "AISupportAgent"',
        { stdio: 'pipe' },
      )
      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('should succeed even if End fails (task not running)', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))  // Query
        .mockImplementationOnce(() => { throw new Error('not running') })  // End
        .mockReturnValueOnce(Buffer.from(''))  // Run

      strategy.restart()

      expect(logger.success).toHaveBeenCalledWith('service.restarted')
    })

    it('should log error if Run fails', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))  // Query
        .mockReturnValueOnce(Buffer.from(''))  // End
        .mockImplementationOnce(() => { throw new Error('run failed') })  // Run

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.restartFailed'),
      )
    })

    it('should handle non-Error throw from Run', () => {
      mockedExecSync
        .mockReturnValueOnce(Buffer.from(''))  // Query
        .mockReturnValueOnce(Buffer.from(''))  // End
        .mockImplementationOnce(() => { throw 'string run error' })  // Run

      strategy.restart()

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('service.restartFailed'),
      )
    })
  })

  describe('status', () => {
    it('should return not installed when task does not exist', () => {
      mockedExecSync.mockImplementation(() => { throw new Error('not found') })

      const result = strategy.status()

      expect(result).toEqual({ installed: false, running: false })
    })

    it('should return running when task is Running', () => {
      mockedExecSync.mockReturnValue(Buffer.from('"AISupportAgent","Running"'))

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(true)
      expect(result.logDir).toBeTruthy()
    })

    it('should return not running when task is Ready', () => {
      mockedExecSync.mockReturnValue(Buffer.from('"AISupportAgent","Ready"'))

      const result = strategy.status()

      expect(result.installed).toBe(true)
      expect(result.running).toBe(false)
    })
  })
})
