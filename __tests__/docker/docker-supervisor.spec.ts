/**
 * Tests for src/docker/docker-supervisor.ts
 *
 * Exercises DockerSupervisor: start(), spawnProject(), rebuildAndRestart(),
 * stopAll(), projectKey(), getProjectAgentId(), setProjectAgentId(),
 * getImageTag(), and signal-handler registration.
 */

import { EventEmitter } from 'events'

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }),
  unlinkSync: jest.fn(),
  writeFileSync: jest.fn(),
  copyFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  watch: jest.fn(() => ({ close: jest.fn() })),
}))

jest.mock('../../src/i18n', () => ({
  t: jest.fn((key: string, params?: Record<string, string>) => {
    if (params) {
      let msg = key
      for (const [k, v] of Object.entries(params)) {
        msg += ` ${k}=${v}`
      }
      return msg
    }
    return key
  }),
  initI18n: jest.fn(),
}))

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
  getProjectColor: jest.fn().mockReturnValue('\x1b[36m'),
  makeLinePrefixer: jest.fn().mockImplementation(
    (_prefix: string, write: (s: string) => void) => (chunk: string) => write(chunk),
  ),
}))

jest.mock('../../src/pid-manager', () => ({
  removePidFile: jest.fn(),
}))

jest.mock('../../src/api-client', () => ({
  ApiClient: jest.fn().mockImplementation(() => ({
    submitLogChunk: jest.fn().mockResolvedValue(undefined),
    saveSessionLog: jest.fn().mockResolvedValue(undefined),
  })),
}))

jest.mock('../../src/docker/dockerfile-path', () => ({
  getProjectImageTag: jest.fn(
    (tenantCode: string, projectCode: string, version: string) =>
      `ai-support-agent-${tenantCode}-${projectCode}:${version}`,
  ),
}))

jest.mock('../../src/docker/docker-utils', () => ({
  IMAGE_NAME: 'ai-support-agent',
  buildContainerName: jest.fn(
    (tenantCode: string, projectCode: string, agentId?: string) => {
      const base = `ai-${tenantCode}-${projectCode}`.toLowerCase().replace(/[^a-z0-9-]/g, '-')
      return agentId ? `${base}-${agentId}` : base
    },
  ),
  removeStaleContainer: jest.fn(),
  makeSessionId: jest.fn().mockReturnValue('20260101000000'),
  resolveImageTag: jest.fn(
    (projectTag: string, _baseTag: string) => projectTag,
  ),
  getDockerPath: jest.fn().mockReturnValue('docker'),
  buildDevMounts: jest.fn().mockReturnValue([]),
}))

jest.mock('../../src/docker/volume-mount-builder', () => ({
  buildProjectVolumeMounts: jest.fn().mockReturnValue({
    mounts: ['-v', '/host/path:/container/path:rw'],
    envArgs: ['-e', 'AI_SUPPORT_AGENT_TOKEN=test-token'],
  }),
}))

jest.mock('../../src/docker/project-image-builder', () => ({
  buildProjectImage: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../src/docker/project-config', () => ({
  getProjectConfigHostDir: jest.fn(
    (project: { tenantCode: string; projectCode: string }) =>
      `/mock/config-dir/projects/${project.tenantCode}/${project.projectCode}/.ai-support-agent`,
  ),
  migrateProjectConfigDir: jest.fn(),
}))

jest.mock('../../src/docker/update-handler', () => ({
  installUpdateAndRestart: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../src/utils', () => ({
  getErrorMessage: jest.fn((e: unknown) => (e instanceof Error ? e.message : String(e))),
}))

import { spawn } from 'child_process'
import * as fs from 'fs'

import { logger } from '../../src/logger'
import { removePidFile } from '../../src/pid-manager'
import { buildProjectImage } from '../../src/docker/project-image-builder'
import { installUpdateAndRestart } from '../../src/docker/update-handler'
import { migrateProjectConfigDir } from '../../src/docker/project-config'
import { DockerSupervisor } from '../../src/docker/docker-supervisor'
import type { ProjectRegistration } from '../../src/types'
import type { DockerRunOptions } from '../../src/docker/docker-runner'

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>
const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>
const mockUnlinkSync = fs.unlinkSync as jest.MockedFunction<typeof fs.unlinkSync>
const mockWatch = fs.watch as jest.MockedFunction<typeof fs.watch>
const mockBuildProjectImage = buildProjectImage as jest.MockedFunction<typeof buildProjectImage>
const mockInstallUpdateAndRestart = installUpdateAndRestart as jest.MockedFunction<typeof installUpdateAndRestart>
const mockMigrateProjectConfigDir = migrateProjectConfigDir as jest.MockedFunction<typeof migrateProjectConfigDir>

/**
 * Create a fake child process that behaves like a real ChildProcess.
 */
function makeFakeChild(): EventEmitter & {
  kill: jest.Mock
  stdout: EventEmitter & { on: jest.Mock }
  stderr: EventEmitter & { on: jest.Mock }
} {
  const child = new EventEmitter() as EventEmitter & {
    kill: jest.Mock
    stdout: EventEmitter & { on: jest.Mock }
    stderr: EventEmitter & { on: jest.Mock }
  }
  child.kill = jest.fn()
  child.stdout = Object.assign(new EventEmitter(), { on: jest.fn().mockImplementation((...args: Parameters<EventEmitter['on']>) => { EventEmitter.prototype.on.apply(child.stdout, args); return child.stdout }) })
  child.stderr = Object.assign(new EventEmitter(), { on: jest.fn().mockImplementation((...args: Parameters<EventEmitter['on']>) => { EventEmitter.prototype.on.apply(child.stderr, args); return child.stderr }) })
  return child
}

function makeProject(overrides: Partial<ProjectRegistration> = {}): ProjectRegistration {
  return {
    tenantCode: 'mbc',
    projectCode: 'PROJ_A',
    token: 'test-token',
    apiUrl: 'http://api.example.com',
    ...overrides,
  }
}

function makeOpts(overrides: Partial<DockerRunOptions> = {}): DockerRunOptions {
  return {
    shutdownTimeoutMs: 100,
    ...overrides,
  }
}

describe('DockerSupervisor', () => {
  let mockExit: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()
    mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    mockExistsSync.mockReturnValue(false)
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
  })

  afterEach(() => {
    jest.useRealTimers()
    mockExit.mockRestore()
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
  })

  // ─── projectKey ───────────────────────────────────────────────────────────

  describe('projectKey (via start/spawnProject)', () => {
    it('formats key as tenantCode/projectCode', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      const project = makeProject({ tenantCode: 'acme', projectCode: 'MY_PROJ' })
      supervisor.start([project])

      // logger.info contains the key
      const calls = (logger.info as jest.Mock).mock.calls.map((c: unknown[]) => String(c[0]))
      expect(calls.some((s) => s.includes('acme/MY_PROJ'))).toBe(true)
    })
  })

  // ─── getProjectAgentId / setProjectAgentId ────────────────────────────────

  describe('getProjectAgentId / setProjectAgentId', () => {
    it('returns defaultAgentId when no per-project id is set', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ agentId: 'default-agent' }))
      const project = makeProject()
      supervisor.start([project])

      // After starting, the registered-agent-id file watcher is set up.
      // The watcher fires with a new id file — simulate by triggering the watch callback.
      const watchCb = (mockWatch as jest.Mock).mock.calls[0]?.[1] as
        | ((eventType: string, filename: string) => void)
        | undefined

      if (watchCb) {
        mockReadFileSync.mockReturnValueOnce('new-agent-id')
        watchCb('rename', 'docker-registered-agent-id')
      }

      // After setting, the next spawnProject should log the new id
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('new-agent-id'),
      )
    })

    it('loads agentId from registered-agent-id file at spawn time', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      // Simulate registered agentId file present before spawn
      mockExistsSync.mockImplementation((p: unknown) => {
        return typeof p === 'string' && p.endsWith('docker-registered-agent-id')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('docker-registered-agent-id')) {
          return 'registered-123'
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('registered-123'),
      )
    })
  })

  // ─── getImageTag ──────────────────────────────────────────────────────────

  describe('getImageTag', () => {
    it('resolves the project-specific image tag via resolveImageTag', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('2.0.0', makeOpts())
      supervisor.start([makeProject({ tenantCode: 'mbc', projectCode: 'PROJ_A' })])

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      // The image tag is the last element before containerArgs
      expect(spawnArgs.some((a) => a.includes('ai-support-agent-mbc-PROJ_A:2.0.0'))).toBe(true)
    })
  })

  // ─── start() ─────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('spawns one container per project', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([
        makeProject({ projectCode: 'PROJ_A' }),
        makeProject({ projectCode: 'PROJ_B' }),
      ])

      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })

    it('calls migrateProjectConfigDir for each project', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      expect(mockMigrateProjectConfigDir).toHaveBeenCalledTimes(1)
    })

    it('registers SIGINT and SIGTERM handlers', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const processOnSpy = jest.spyOn(process, 'on')
      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      const sigintCall = processOnSpy.mock.calls.find((c) => c[0] === 'SIGINT')
      const sigtermCall = processOnSpy.mock.calls.find((c) => c[0] === 'SIGTERM')
      expect(sigintCall).toBeDefined()
      expect(sigtermCall).toBeDefined()

      processOnSpy.mockRestore()
    })

    it('does not abort remaining projects when one project spawn fails', () => {
      let callCount = 0
      mockMigrateProjectConfigDir.mockImplementation(() => {
        callCount++
        if (callCount === 1) throw new Error('migrate error')
      })

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([
        makeProject({ projectCode: 'PROJ_FAIL' }),
        makeProject({ projectCode: 'PROJ_OK' }),
      ])

      // First project fails → error logged
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('docker.projectSpawnFailed'),
      )
      // Second project still spawns
      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    it('calls onStop callback when SIGINT is received', () => {
      jest.useFakeTimers()
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const onStop = jest.fn()
      const processOnSpy = jest.spyOn(process, 'on')

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()], onStop)

      const sigintHandler = processOnSpy.mock.calls.find((c) => c[0] === 'SIGINT')
      expect(sigintHandler).toBeDefined()
      const handler = sigintHandler![1] as () => void
      handler()

      expect(onStop).toHaveBeenCalled()
      expect(removePidFile).toHaveBeenCalled()

      processOnSpy.mockRestore()
    })

    it('does not call onStop twice when shutdown triggered twice', () => {
      jest.useFakeTimers()
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const onStop = jest.fn()
      const processOnSpy = jest.spyOn(process, 'on')

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()], onStop)

      const sigintHandler = processOnSpy.mock.calls.find((c) => c[0] === 'SIGINT')!
      const handler = sigintHandler[1] as () => void
      handler()
      handler() // second call

      expect(onStop).toHaveBeenCalledTimes(1)
      processOnSpy.mockRestore()
    })

    it('forces process.exit after shutdownTimeoutMs when containers are slow to close', async () => {
      jest.useFakeTimers()

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const processOnSpy = jest.spyOn(process, 'on')
      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ shutdownTimeoutMs: 50 }))
      supervisor.start([makeProject()])

      const sigintHandler = processOnSpy.mock.calls.find((c) => c[0] === 'SIGINT')
      const handler = sigintHandler![1] as () => void
      handler()

      // Fast-forward past shutdown timeout
      jest.advanceTimersByTime(200)

      expect(mockExit).toHaveBeenCalledWith(0)

      jest.useRealTimers()
      processOnSpy.mockRestore()
    })

    it('pre-startup hash mismatch triggers rebuild before spawn', () => {
      // Both hash files exist, but differ → spawnProject should call rebuildAndRestart
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return s.endsWith('docker-customization-hash') || s.endsWith('docker-built-hash')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        const s = p as string
        if (s.endsWith('docker-customization-hash')) return 'hash-new'
        if (s.endsWith('docker-built-hash')) return 'hash-old'
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Rebuild is async; synchronous spawn should NOT have been called
      expect(mockSpawn).not.toHaveBeenCalled()
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Pre-startup hash mismatch'),
      )
    })

    it('pre-startup hash match proceeds to spawn without rebuild', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return s.endsWith('docker-customization-hash') || s.endsWith('docker-built-hash')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        const s = p as string
        if (s.endsWith('docker-customization-hash')) return 'same-hash'
        if (s.endsWith('docker-built-hash')) return 'same-hash'
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })
  })

  // ─── spawnProject() ───────────────────────────────────────────────────────

  describe('spawnProject()', () => {
    it('passes --project flag with tenantCode/projectCode', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject({ tenantCode: 'acme', projectCode: 'MY_PROJ' })])

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      const projIdx = spawnArgs.indexOf('--project')
      expect(projIdx).toBeGreaterThan(-1)
      expect(spawnArgs[projIdx + 1]).toBe('acme/MY_PROJ')
    })

    it('passes --poll-interval when pollInterval is set', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ pollInterval: 3000 }))
      supervisor.start([makeProject()])

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--poll-interval')
      expect(spawnArgs).toContain('3000')
    })

    it('passes --heartbeat-interval when heartbeatInterval is set', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ heartbeatInterval: 60000 }))
      supervisor.start([makeProject()])

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--heartbeat-interval')
      expect(spawnArgs).toContain('60000')
    })

    it('passes --verbose when verbose is true', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ verbose: true }))
      supervisor.start([makeProject()])

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--verbose')
    })

    it('passes --no-auto-update when autoUpdate is false', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ autoUpdate: false }))
      supervisor.start([makeProject()])

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--no-auto-update')
    })

    it('does not pass --no-auto-update when autoUpdate is true', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ autoUpdate: true }))
      supervisor.start([makeProject()])

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).not.toContain('--no-auto-update')
    })

    it('passes --update-channel when updateChannel is set', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ updateChannel: 'beta' }))
      supervisor.start([makeProject()])

      const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
      expect(spawnArgs).toContain('--update-channel')
      expect(spawnArgs).toContain('beta')
    })

    it('logs container error when child emits error event', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild.emit('error', new Error('spawn ENOENT'))

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Container error'),
      )
    })

    it('removes container from handles when it exits', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Container exits cleanly → process.exit(0) and handles becomes empty
      fakeChild.emit('close', 0)

      expect(mockExit).toHaveBeenCalledWith(0)
    })

    it('calls process.exit when all containers exit cleanly', () => {
      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let callNum = 0
      mockSpawn.mockImplementation(() => {
        callNum++
        return (callNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([
        makeProject({ projectCode: 'PROJ_A' }),
        makeProject({ projectCode: 'PROJ_B' }),
      ])

      fakeChild1.emit('close', 0)
      // Only one container remains → still alive
      expect(mockExit).not.toHaveBeenCalled()

      fakeChild2.emit('close', 0)
      // All containers gone → exit
      expect(mockExit).toHaveBeenCalledWith(0)
    })

    it('triggers installUpdateAndRestart when exit code is DOCKER_UPDATE_EXIT_CODE (42)', async () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild.emit('close', 42)
      await Promise.resolve()
      await Promise.resolve()

      expect(mockInstallUpdateAndRestart).toHaveBeenCalled()
    })

    it('does not trigger update restart a second time after updating flag is set', async () => {
      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let callNum = 0
      mockSpawn.mockImplementation(() => {
        callNum++
        return (callNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([
        makeProject({ projectCode: 'PROJ_A' }),
        makeProject({ projectCode: 'PROJ_B' }),
      ])

      fakeChild1.emit('close', 42)
      fakeChild2.emit('close', 42)

      await Promise.resolve()
      await Promise.resolve()

      // installUpdateAndRestart should only be called once
      expect(mockInstallUpdateAndRestart).toHaveBeenCalledTimes(1)
    })

    it('triggers rebuildAndRestart when exit code is DOCKER_RESTART_EXIT_CODE (43)', async () => {
      const fakeChild1 = makeFakeChild()
      // fakeChild2 never emits 'close' to avoid infinite rebuild loop
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43)
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((r) => setImmediate(r))

      // rebuildAndRestart will eventually call spawnProject again
      // mockBuildProjectImage shows that no build was triggered (no Dockerfile)
      expect(mockBuildProjectImage).not.toHaveBeenCalled()
      // But spawn IS called again for the project restart
      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })

    it('tries to unlink cidFile on close', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild.emit('close', 0)

      expect(mockUnlinkSync).toHaveBeenCalled()
    })

    it('does not throw when cidFile unlink fails', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)
      mockUnlinkSync.mockImplementation(() => { throw new Error('ENOENT') })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      expect(() => {
        supervisor.start([makeProject()])
        fakeChild.emit('close', 0)
      }).not.toThrow()

      // Restore to avoid bleed-over to subsequent tests
      mockUnlinkSync.mockReset()
    })

    it('sets up fs.watch on projectConfigHostDir for registered agentId', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      expect(mockWatch).toHaveBeenCalledWith(
        expect.stringContaining('mbc/PROJ_A/.ai-support-agent'),
        expect.any(Function),
      )
    })

    it('updates agentId via watcher when docker-registered-agent-id is renamed', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ agentId: 'old-id' }))
      supervisor.start([makeProject()])

      // Simulate the watcher callback
      const watchCallback = mockWatch.mock.calls[0][1] as (
        eventType: string,
        filename: string,
      ) => void

      mockReadFileSync.mockReturnValueOnce('new-container-agent-id')
      mockExistsSync.mockReturnValueOnce(true)
      watchCallback('rename', 'docker-registered-agent-id')

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('new-container-agent-id'),
      )
    })

    it('silently handles fs.watch failure on missing projectConfigHostDir', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)
      mockWatch.mockImplementation(() => { throw new Error('ENOENT') })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      expect(() => {
        supervisor.start([makeProject()])
      }).not.toThrow()
    })

    it('closes watcher and resolves closedPromise on container close', async () => {
      const watcherClose = jest.fn()
      mockWatch.mockReturnValue({ close: watcherClose } as unknown as ReturnType<typeof fs.watch>)

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild.emit('close', 0)

      // Allow microtasks (flush + saveSessionLog chain) to run
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(watcherClose).toHaveBeenCalled()
    })
  })

  // ─── rebuildAndRestart() ──────────────────────────────────────────────────

  describe('rebuildAndRestart()', () => {
    it('skips build and calls spawnProject when no marker and forceIfDockerfileExists=false', async () => {
      // Trigger restart via exit code 43 (no Dockerfile present)
      mockExistsSync.mockReturnValue(false)

      const fakeChild1 = makeFakeChild()
      // fakeChild2 never emits 'close' to avoid infinite rebuild loop
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43)
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((r) => setImmediate(r))

      expect(mockBuildProjectImage).not.toHaveBeenCalled()
      // Spawned twice: initial + restart
      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })

    it('builds image when docker-rebuild-needed marker exists', async () => {
      // Reset mock state fully to avoid bleed-over from previous tests.
      mockExistsSync.mockReset()
      mockReadFileSync.mockReset()
      mockUnlinkSync.mockReset()
      mockReadFileSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      // Set up existsSync so:
      //   - hash files do NOT exist (prevents pre-startup hash-check rebuild loop)
      //   - registered-agent-id does NOT exist (avoids readFileSync call)
      //   - docker-rebuild-needed and Dockerfile DO exist (triggers build in rebuildAndRestart)
      // Note: docker-rebuild-needed and Dockerfile can "exist" from the start because
      // initial spawnProject only checks for customization-hash/built-hash before spawning.
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return (s.endsWith('docker-rebuild-needed') || s.endsWith('Dockerfile')) &&
          !s.endsWith('docker-registered-agent-id') &&
          !s.endsWith('docker-customization-hash') &&
          !s.endsWith('docker-built-hash')
      })

      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43)
      // rebuildAndRestart is async — flush multiple microtask queues
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))

      expect(mockBuildProjectImage).toHaveBeenCalled()
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('docker-rebuild-needed'),
      )
    })

    it('builds image on restart when forceIfDockerfileExists=true and Dockerfile exists', async () => {
      // forceIfDockerfileExists=true is used when exit code is 43 — if only Dockerfile exists
      // (no marker), build is still triggered.
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        // Only Dockerfile exists — no marker, no hash files, no registered-id
        return s.endsWith('Dockerfile') &&
          !s.endsWith('docker-rebuild-needed') &&
          !s.endsWith('docker-registered-agent-id') &&
          !s.endsWith('docker-customization-hash') &&
          !s.endsWith('docker-built-hash')
      })

      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43)
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      expect(mockBuildProjectImage).toHaveBeenCalled()
    })

    it('logs error and continues when buildProjectImage throws', async () => {
      mockExistsSync.mockReset()
      mockReadFileSync.mockReset()
      mockUnlinkSync.mockReset()
      mockReadFileSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return (s.endsWith('docker-rebuild-needed') || s.endsWith('Dockerfile')) &&
          !s.endsWith('docker-registered-agent-id') &&
          !s.endsWith('docker-customization-hash') &&
          !s.endsWith('docker-built-hash')
      })

      mockBuildProjectImage.mockRejectedValueOnce(new Error('build failed'))

      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43)
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Image build failed'),
      )
      // spawn is still called for restart even after build failure
      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })

    it('reads registered agentId from file before building to use correct id for build logs', async () => {
      mockExistsSync.mockReset()
      mockReadFileSync.mockReset()
      mockUnlinkSync.mockReset()

      // In this test, marker + Dockerfile + registered-agent-id all exist.
      // readFileSync returns the registered agentId for that path.
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return (
          s.endsWith('docker-rebuild-needed') ||
          s.endsWith('Dockerfile') ||
          s.endsWith('docker-registered-agent-id')
        ) &&
          !s.endsWith('docker-customization-hash') &&
          !s.endsWith('docker-built-hash')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('docker-registered-agent-id')) {
          return 'container-registered-agent'
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ agentId: 'host-agent' }))
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43)
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      expect(mockBuildProjectImage).toHaveBeenCalledWith(
        'mbc',
        'PROJ_A',
        '1.0.0',
        expect.any(String),
        expect.anything(),
        'container-registered-agent',
      )
    })

    it('skips setProjectAgentId when registered agentId matches current agentId', async () => {
      mockExistsSync.mockReset()
      mockReadFileSync.mockReset()
      mockUnlinkSync.mockReset()

      // registered-agent-id file exists and contains the SAME agentId as the supervisor
      const sameAgentId = 'same-agent-id'
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return (
          s.endsWith('docker-rebuild-needed') ||
          s.endsWith('Dockerfile') ||
          s.endsWith('docker-registered-agent-id')
        ) &&
          !s.endsWith('docker-customization-hash') &&
          !s.endsWith('docker-built-hash')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('docker-registered-agent-id')) {
          // Return the same agentId the supervisor already has → setProjectAgentId should NOT be called
          return sameAgentId
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      // Start with agentId = sameAgentId so the registered id matches
      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ agentId: sameAgentId }))
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43)
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      // Build still happens but agentId is the same (unchanged)
      expect(mockBuildProjectImage).toHaveBeenCalledWith(
        'mbc',
        'PROJ_A',
        '1.0.0',
        expect.any(String),
        expect.anything(),
        sameAgentId,
      )
    })

    it('sets agentId from registered-agent-id file during rebuild when no prior agentId is set', async () => {
      // This test covers the true branch of line 168:
      // `registeredId && registeredId !== this.getProjectAgentId(project)`
      // when the agentId was never set during initial spawn (no watcher callback fired).
      mockExistsSync.mockReset()
      mockReadFileSync.mockReset()
      mockUnlinkSync.mockReset()

      const newAgentId = 'rebuild-agent-id'

      // During initial spawn: docker-registered-agent-id does NOT exist (no watcher update)
      // During rebuild: marker + Dockerfile + docker-registered-agent-id DO exist
      let rebuildPhase = false
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        if (!rebuildPhase) {
          // Initial spawn: only irrelevant files exist, no registered-agent-id
          return false
        }
        // Rebuild phase: registered-agent-id, marker, Dockerfile all exist
        return (
          s.endsWith('docker-rebuild-needed') ||
          s.endsWith('Dockerfile') ||
          s.endsWith('docker-registered-agent-id')
        ) && !s.endsWith('docker-customization-hash') && !s.endsWith('docker-built-hash')
      })
      mockReadFileSync.mockImplementation((p: unknown) => {
        if (typeof p === 'string' && p.endsWith('docker-registered-agent-id')) {
          return newAgentId
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      // No defaultAgentId → getProjectAgentId returns undefined
      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Transition to rebuild phase before the close event
      rebuildPhase = true
      fakeChild1.emit('close', 43)
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      // buildProjectImage should be called with the new agent ID from the file
      expect(mockBuildProjectImage).toHaveBeenCalledWith(
        'mbc',
        'PROJ_A',
        '1.0.0',
        expect.any(String),
        expect.anything(),
        newAgentId,
      )
    })
  })

  // ─── stopAll() ────────────────────────────────────────────────────────────

  describe('stopAll()', () => {
    it('kills containers via child.kill(SIGTERM) when cidFile does not exist', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)
      mockExistsSync.mockReturnValue(false)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])
      supervisor.stopAll()

      expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
    })

    it('logs info for each container being stopped', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)
      mockExistsSync.mockReturnValue(false)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      const infoCallsBefore = (logger.info as jest.Mock).mock.calls.length
      supervisor.stopAll()
      const infoCallsAfter = (logger.info as jest.Mock).mock.calls.length

      expect(infoCallsAfter).toBeGreaterThan(infoCallsBefore)
    })

    it('calls stopAll on all containers when SIGTERM is received', () => {
      jest.useFakeTimers()
      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let callNum = 0
      mockSpawn.mockImplementation(() => {
        callNum++
        return (callNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const processOnSpy = jest.spyOn(process, 'on')
      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([
        makeProject({ projectCode: 'PROJ_A' }),
        makeProject({ projectCode: 'PROJ_B' }),
      ])

      const sigtermHandler = processOnSpy.mock.calls.find((c) => c[0] === 'SIGTERM')
      const handler = sigtermHandler![1] as () => void
      handler()

      expect(fakeChild1.kill).toHaveBeenCalledWith('SIGTERM')
      expect(fakeChild2.kill).toHaveBeenCalledWith('SIGTERM')

      processOnSpy.mockRestore()
    })

    it('does not call kill on containers that are already closeHandled', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Simulate container already closed (handle.closeHandled = true)
      fakeChild.emit('close', 0)
      const killCallsBefore = fakeChild.kill.mock.calls.length

      supervisor.stopAll()

      // kill should not be called again for an already-handled container
      expect(fakeChild.kill.mock.calls.length).toBe(killCallsBefore)
    })
  })

  // ─── log streaming ────────────────────────────────────────────────────────

  describe('log streaming', () => {
    it('buffers stdout and stderr data from the container', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Emit stdout data — should write to process.stdout
      const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)

      fakeChild.stdout.emit('data', Buffer.from('hello stdout\n'))
      fakeChild.stderr.emit('data', Buffer.from('hello stderr\n'))

      expect(stdoutWriteSpy).toHaveBeenCalled()
      expect(stderrWriteSpy).toHaveBeenCalled()

      stdoutWriteSpy.mockRestore()
      stderrWriteSpy.mockRestore()
    })
  })
})
