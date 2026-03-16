import { ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import * as child_process from 'child_process'
import * as fs from 'fs'
import * as http from 'http'
import * as path from 'path'

import { VsCodeServer } from '../../src/vscode/vscode-server'

// Mock child_process.spawn
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

// Mock fs
jest.mock('fs', () => ({
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn(() => { throw new Error('ENOENT') }),
}))

// Mock http.get for health checks
jest.mock('http', () => ({
  get: jest.fn(),
  request: jest.fn(),
}))

// Mock logger
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

function createMockProcess(): EventEmitter & Partial<ChildProcess> {
  const proc = new EventEmitter() as EventEmitter & Partial<ChildProcess>
  Object.defineProperty(proc, 'killed', { value: false, writable: true })
  proc.kill = jest.fn()
  proc.stdout = new EventEmitter() as ChildProcess['stdout']
  proc.stderr = new EventEmitter() as ChildProcess['stderr']
  return proc
}

function mockHealthCheckSuccess(): void {
  const mockReq = new EventEmitter()
  ;(http.get as jest.Mock).mockImplementation((_url: string, cb: (res: { statusCode: number; resume: () => void }) => void) => {
    cb({ statusCode: 200, resume: jest.fn() })
    return mockReq
  })
}

describe('VsCodeServer', () => {
  let server: VsCodeServer
  let mockProcess: EventEmitter & Partial<ChildProcess>

  beforeEach(() => {
    jest.clearAllMocks()

    mockProcess = createMockProcess()
    ;(child_process.spawn as jest.Mock).mockReturnValue(mockProcess)

    server = new VsCodeServer({ projectDir: '/test/project' })
  })

  describe('constructor', () => {
    it('should use default port 8443', () => {
      expect(server.getPort()).toBe(8443)
    })

    it('should accept custom port', () => {
      const customServer = new VsCodeServer({ projectDir: '/test', port: 9999 })
      expect(customServer.getPort()).toBe(9999)
    })

    it('should not be running initially', () => {
      expect(server.isRunning).toBe(false)
    })
  })

  describe('start', () => {
    it('should spawn code-server with correct args', async () => {
      mockHealthCheckSuccess()

      await server.start()

      expect(child_process.spawn).toHaveBeenCalledWith(
        'code-server',
        expect.arrayContaining([
          '--bind-addr', '127.0.0.1:8443',
          '--auth', 'none',
          '--disable-telemetry',
          '/test/project',
        ]),
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      )
    })

    it('should set running to true after start', async () => {
      mockHealthCheckSuccess()

      await server.start()
      expect(server.isRunning).toBe(true)
    })

    it('should skip if already running', async () => {
      mockHealthCheckSuccess()

      await server.start()
      expect(server.isRunning).toBe(true)

      // Second call should skip
      await server.start()
      expect(child_process.spawn).toHaveBeenCalledTimes(1)
    })

    it('should fail immediately when code-server is not installed', async () => {
      ;(http.get as jest.Mock).mockImplementation(() => {
        const req = new EventEmitter()
        return req
      })

      const errorProcess = createMockProcess()
      ;(child_process.spawn as jest.Mock).mockReturnValue(errorProcess)

      server = new VsCodeServer({ projectDir: '/test/project' })

      const startPromise = server.start()

      errorProcess.emit('error', new Error('spawn code-server ENOENT'))

      await expect(startPromise).rejects.toThrow('code-server is not installed or not in PATH')
    })

    it('should set environment variables for XDG dirs', async () => {
      mockHealthCheckSuccess()

      await server.start()

      expect(child_process.spawn).toHaveBeenCalledWith(
        'code-server',
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            XDG_DATA_HOME: '/test/project/.vscode-server/data',
            XDG_CONFIG_HOME: '/test/project/.vscode-server/config',
          }),
        }),
      )
    })

    it('should log stdout data', async () => {
      mockHealthCheckSuccess()
      const { logger } = require('../../src/logger')

      await server.start()
      mockProcess.stdout!.emit('data', Buffer.from('server started'))

      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('server started'))
    })

    it('should log stderr data', async () => {
      mockHealthCheckSuccess()
      const { logger } = require('../../src/logger')

      await server.start()
      mockProcess.stderr!.emit('data', Buffer.from('warning message'))

      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('warning message'))
    })

    it('should retry health check during waitForReady', async () => {
      let callCount = 0
      ;(http.get as jest.Mock).mockImplementation((_url: string, cb: (res: { statusCode: number; resume: () => void }) => void) => {
        const req = new EventEmitter()
        callCount++
        if (callCount >= 2) {
          cb({ statusCode: 200, resume: jest.fn() })
        } else {
          process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')))
        }
        return req
      })

      await server.start()
      expect(server.isRunning).toBe(true)
      expect(callCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe('stop', () => {
    it('should do nothing if not started', () => {
      server.stop()
      expect(mockProcess.kill).not.toHaveBeenCalled()
    })

    it('should send SIGTERM to process', async () => {
      mockHealthCheckSuccess()

      await server.start()
      server.stop()

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM')
      expect(server.isRunning).toBe(false)
    })

    it('should handle stop errors gracefully', async () => {
      mockHealthCheckSuccess()

      await server.start()

      // Make kill throw
      mockProcess.kill = jest.fn(() => { throw new Error('kill failed') })

      expect(() => server.stop()).not.toThrow()
    })
  })

  describe('touch', () => {
    it('should not throw when called', () => {
      expect(() => server.touch()).not.toThrow()
    })
  })

  describe('checkHealth (private)', () => {
    it('should resolve on 200 status', async () => {
      ;(http.get as jest.Mock).mockImplementation((_url: string, cb: (res: { statusCode: number; resume: () => void }) => void) => {
        const req = new EventEmitter()
        ;(req as any).setTimeout = jest.fn()
        cb({ statusCode: 200, resume: jest.fn() })
        return req
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((server as any).checkHealth()).resolves.toBeUndefined()
    })

    it('should reject on non-200 status', async () => {
      ;(http.get as jest.Mock).mockImplementation((_url: string, cb: (res: { statusCode: number; resume: () => void }) => void) => {
        const req = new EventEmitter()
        ;(req as any).setTimeout = jest.fn()
        cb({ statusCode: 503, resume: jest.fn() })
        return req
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((server as any).checkHealth()).rejects.toThrow('Health check returned status 503')
    })

    it('should reject on request error', async () => {
      ;(http.get as jest.Mock).mockImplementation(() => {
        const req = new EventEmitter()
        ;(req as any).setTimeout = jest.fn()
        process.nextTick(() => req.emit('error', new Error('ECONNREFUSED')))
        return req
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((server as any).checkHealth()).rejects.toThrow('ECONNREFUSED')
    })

    it('should reject on timeout', async () => {
      ;(http.get as jest.Mock).mockImplementation(() => {
        const req = new EventEmitter()
        ;(req as any).destroy = jest.fn()
        ;(req as any).setTimeout = jest.fn((_ms: number, cb: () => void) => {
          process.nextTick(cb)
        })
        return req
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect((server as any).checkHealth()).rejects.toThrow('Health check timeout')
    })
  })

  describe('resetIdleTimer (private)', () => {
    it('should set idle timer', () => {
      jest.useFakeTimers()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).resetIdleTimer()

      // Timer should be set
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((server as any).idleTimer).not.toBeNull()

      // Clean up
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).stopTimers()
      jest.useRealTimers()
    })

    it('should replace existing timer on subsequent calls', () => {
      jest.useFakeTimers()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).resetIdleTimer()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const firstTimer = (server as any).idleTimer

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).resetIdleTimer()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const secondTimer = (server as any).idleTimer

      expect(secondTimer).not.toBe(firstTimer)

      // Clean up
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).stopTimers()
      jest.useRealTimers()
    })

    it('should call stop when idle timeout fires', () => {
      jest.useFakeTimers()

      const stopSpy = jest.spyOn(server, 'stop')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).resetIdleTimer()

      jest.advanceTimersByTime(30 * 60 * 1000 + 1)

      expect(stopSpy).toHaveBeenCalled()
      stopSpy.mockRestore()
      jest.useRealTimers()
    })
  })

  describe('startHealthCheck (private)', () => {
    it('should set up periodic health check interval', () => {
      jest.useFakeTimers()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).startHealthCheck()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((server as any).healthTimer).not.toBeNull()

      // Clean up
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).stopTimers()
      jest.useRealTimers()
    })

    it('should call checkHealth in interval callback', async () => {
      jest.useFakeTimers()

      // Mock checkHealth to resolve immediately
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const checkHealthSpy = jest.spyOn(server as any, 'checkHealth').mockResolvedValue(undefined)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).startHealthCheck()

      // Advance past one interval (HEALTH_CHECK_INTERVAL_MS = 30000)
      jest.advanceTimersByTime(30001)

      expect(checkHealthSpy).toHaveBeenCalled()

      checkHealthSpy.mockRestore()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).stopTimers()
      jest.useRealTimers()
    })
  })

  describe('stopTimers (private)', () => {
    it('should clear both idle and health timers', () => {
      jest.useFakeTimers()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).idleTimer = setTimeout(() => {}, 1000)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).healthTimer = setInterval(() => {}, 1000)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(server as any).stopTimers()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((server as any).idleTimer).toBeNull()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((server as any).healthTimer).toBeNull()
      jest.useRealTimers()
    })
  })

  describe('process exit handling', () => {
    it('should mark as not running when process exits', async () => {
      mockHealthCheckSuccess()

      await server.start()
      expect(server.isRunning).toBe(true)

      mockProcess.emit('exit', 0, null)
      expect(server.isRunning).toBe(false)
    })
  })

  describe('setupTerminalSandbox (private)', () => {
    const resolvedProject = path.resolve('/test/project')

    it('should create sandbox directory', async () => {
      mockHealthCheckSuccess()

      await server.start()

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join(resolvedProject, '.vscode-server', 'terminal-sandbox'),
        { recursive: true },
      )
    })

    it('should create settings directory', async () => {
      mockHealthCheckSuccess()

      await server.start()

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join(resolvedProject, '.vscode-server', 'data', 'code-server', 'User'),
        { recursive: true },
      )
    })

    it('should write .bashrc with sandbox script', async () => {
      mockHealthCheckSuccess()

      await server.start()

      const bashrcPath = path.join(resolvedProject, '.vscode-server', 'terminal-sandbox', '.bashrc')
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        bashrcPath,
        expect.stringContaining('__SANDBOX_DIR='),
      )
      // Should also load original .bashrc
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        bashrcPath,
        expect.stringContaining('source ~/.bashrc'),
      )
    })

    it('should write .zshrc with sandbox script', async () => {
      mockHealthCheckSuccess()

      await server.start()

      const zshrcPath = path.join(resolvedProject, '.vscode-server', 'terminal-sandbox', '.zshrc')
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        zshrcPath,
        expect.stringContaining('__SANDBOX_DIR='),
      )
    })

    it('should write settings.json with terminal profiles', async () => {
      mockHealthCheckSuccess()

      await server.start()

      const settingsPath = path.join(
        resolvedProject, '.vscode-server', 'data', 'code-server', 'User', 'settings.json',
      )
      const writeCall = (fs.writeFileSync as jest.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === settingsPath,
      )
      expect(writeCall).toBeDefined()

      const settings = JSON.parse(writeCall[1])
      expect(settings['terminal.integrated.profiles.osx']).toHaveProperty('sandbox-bash')
      expect(settings['terminal.integrated.profiles.osx']).toHaveProperty('sandbox-zsh')
      expect(settings['terminal.integrated.profiles.linux']).toHaveProperty('sandbox-bash')
      expect(settings['terminal.integrated.profiles.linux']).toHaveProperty('sandbox-zsh')
      expect(settings['terminal.integrated.cwd']).toBe(resolvedProject)
      expect(settings['security.workspace.trust.enabled']).toBe(true)
      expect(settings['security.workspace.trust.startupPrompt']).toBe('never')
    })

    it('should set default profile based on SHELL env', async () => {
      mockHealthCheckSuccess()
      const origShell = process.env.SHELL

      try {
        process.env.SHELL = '/bin/zsh'
        server = new VsCodeServer({ projectDir: '/test/project' })
        ;(child_process.spawn as jest.Mock).mockReturnValue(mockProcess)

        await server.start()

        const settingsPath = path.join(
          resolvedProject, '.vscode-server', 'data', 'code-server', 'User', 'settings.json',
        )
        const writeCall = (fs.writeFileSync as jest.Mock).mock.calls.find(
          (call: unknown[]) => call[0] === settingsPath,
        )
        const settings = JSON.parse(writeCall[1])
        expect(settings['terminal.integrated.defaultProfile.osx']).toBe('sandbox-zsh')
        expect(settings['terminal.integrated.defaultProfile.linux']).toBe('sandbox-zsh')
      } finally {
        process.env.SHELL = origShell
      }
    })

    it('should merge with existing settings.json', async () => {
      mockHealthCheckSuccess()

      const existingSettings = { 'editor.fontSize': 14, 'some.other.setting': true }
      ;(fs.readFileSync as jest.Mock).mockReturnValueOnce(JSON.stringify(existingSettings))

      await server.start()

      const settingsPath = path.join(
        resolvedProject, '.vscode-server', 'data', 'code-server', 'User', 'settings.json',
      )
      const writeCall = (fs.writeFileSync as jest.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === settingsPath,
      )
      const settings = JSON.parse(writeCall[1])
      expect(settings['editor.fontSize']).toBe(14)
      expect(settings['some.other.setting']).toBe(true)
      expect(settings['terminal.integrated.profiles.osx']).toBeDefined()
    })

    it('should deep merge existing terminal profiles', async () => {
      mockHealthCheckSuccess()

      const existingSettings = {
        'terminal.integrated.profiles.osx': {
          'my-custom-profile': { path: '/bin/fish' },
        },
      }
      ;(fs.readFileSync as jest.Mock).mockReturnValueOnce(JSON.stringify(existingSettings))

      await server.start()

      const settingsPath = path.join(
        resolvedProject, '.vscode-server', 'data', 'code-server', 'User', 'settings.json',
      )
      const writeCall = (fs.writeFileSync as jest.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === settingsPath,
      )
      const settings = JSON.parse(writeCall[1])
      // User's custom profile should be preserved
      expect(settings['terminal.integrated.profiles.osx']['my-custom-profile']).toEqual({ path: '/bin/fish' })
      // Sandbox profiles should also exist
      expect(settings['terminal.integrated.profiles.osx']['sandbox-bash']).toBeDefined()
      expect(settings['terminal.integrated.profiles.osx']['sandbox-zsh']).toBeDefined()
    })

    it('should set sandbox-bash as default when SHELL is bash', async () => {
      mockHealthCheckSuccess()
      const origShell = process.env.SHELL

      try {
        process.env.SHELL = '/bin/bash'
        server = new VsCodeServer({ projectDir: '/test/project' })
        ;(child_process.spawn as jest.Mock).mockReturnValue(mockProcess)

        await server.start()

        const settingsPath = path.join(
          resolvedProject, '.vscode-server', 'data', 'code-server', 'User', 'settings.json',
        )
        const writeCall = (fs.writeFileSync as jest.Mock).mock.calls.find(
          (call: unknown[]) => call[0] === settingsPath,
        )
        const settings = JSON.parse(writeCall[1])
        expect(settings['terminal.integrated.defaultProfile.osx']).toBe('sandbox-bash')
      } finally {
        process.env.SHELL = origShell
      }
    })

    it('should write keybindings.json with Open Folder disable entries', async () => {
      mockHealthCheckSuccess()

      await server.start()

      const keybindingsPath = path.join(
        resolvedProject, '.vscode-server', 'data', 'code-server', 'User', 'keybindings.json',
      )
      const writeCall = (fs.writeFileSync as jest.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === keybindingsPath,
      )
      expect(writeCall).toBeDefined()

      const keybindings = JSON.parse(writeCall[1])
      expect(Array.isArray(keybindings)).toBe(true)
      expect(keybindings.length).toBeGreaterThan(0)
      // All entries should be unbind commands (prefixed with "-")
      for (const entry of keybindings) {
        expect(entry.command).toMatch(/^-/)
      }
      // Should include ctrl+o unbind
      const keys = keybindings.map((k: { key: string }) => k.key)
      expect(keys).toContain('ctrl+o')
    })

    it('should set window.menuBarVisibility to hidden', async () => {
      mockHealthCheckSuccess()

      await server.start()

      const settingsPath = path.join(
        resolvedProject, '.vscode-server', 'data', 'code-server', 'User', 'settings.json',
      )
      const writeCall = (fs.writeFileSync as jest.Mock).mock.calls.find(
        (call: unknown[]) => call[0] === settingsPath,
      )
      const settings = JSON.parse(writeCall[1])
      expect(settings['window.menuBarVisibility']).toBe('hidden')
    })

    it('should still start code-server when sandbox setup fails', async () => {
      mockHealthCheckSuccess()

      // Make mkdirSync throw on first call (sandbox dir creation)
      ;(fs.mkdirSync as jest.Mock).mockImplementationOnce(() => {
        throw new Error('Permission denied')
      })

      await server.start()

      // code-server should still be running despite sandbox failure
      expect(server.isRunning).toBe(true)
      expect(child_process.spawn).toHaveBeenCalledWith('code-server', expect.any(Array), expect.any(Object))
    })
  })
})
