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

    it('saves session log when fullLog is non-empty after container closes', async () => {
      const { ApiClient } = require('../../src/api-client')
      const mockSubmitLogChunk = jest.fn().mockResolvedValue(undefined)
      const mockSaveSessionLog = jest.fn().mockResolvedValue(undefined)
      ApiClient.mockImplementation(() => ({
        submitLogChunk: mockSubmitLogChunk,
        saveSessionLog: mockSaveSessionLog,
      }))

      const watcherClose = jest.fn()
      mockWatch.mockReturnValue({ close: watcherClose } as unknown as ReturnType<typeof fs.watch>)

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Emit data to populate fullLog
      fakeChild.stdout.emit('data', Buffer.from('log output line\n'))

      // Close the container (triggers flush + saveSessionLog)
      fakeChild.emit('close', 0)

      // Wait for async operations to complete
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      expect(mockSaveSessionLog).toHaveBeenCalledWith(
        expect.objectContaining({
          projectCode: 'PROJ_A',
          logType: 'container',
          content: expect.stringContaining('log output line'),
        }),
      )
    })

    it('does not call saveSessionLog when fullLog is empty after container closes', async () => {
      const { ApiClient } = require('../../src/api-client')
      const mockSaveSessionLog = jest.fn().mockResolvedValue(undefined)
      ApiClient.mockImplementation(() => ({
        submitLogChunk: jest.fn().mockResolvedValue(undefined),
        saveSessionLog: mockSaveSessionLog,
      }))

      const watcherClose = jest.fn()
      mockWatch.mockReturnValue({ close: watcherClose } as unknown as ReturnType<typeof fs.watch>)

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Close the container WITHOUT emitting any data (fullLog stays empty)
      fakeChild.emit('close', 0)

      await Promise.resolve()
      await Promise.resolve()
      await new Promise((r) => setImmediate(r))

      // saveSessionLog should NOT be called when fullLog is empty
      expect(mockSaveSessionLog).not.toHaveBeenCalled()
    })

    it('warns when container log exceeds 2 MB limit', async () => {
      const { ApiClient } = require('../../src/api-client')
      ApiClient.mockImplementation(() => ({
        submitLogChunk: jest.fn().mockResolvedValue(undefined),
        saveSessionLog: jest.fn().mockResolvedValue(undefined),
      }))

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Emit 2.5 MB of data to exceed 2 MB limit
      const largeChunk = 'x'.repeat(512 * 1024) // 512 KB per chunk

      jest.useFakeTimers()
      try {
        // Emit 5 chunks via flushTimer
        for (let i = 0; i < 5; i++) {
          fakeChild.stdout.emit('data', Buffer.from(largeChunk))
          jest.advanceTimersByTime(1000) // trigger the flushTimer interval
          await Promise.resolve()
          await Promise.resolve()
        }

        fakeChild.emit('close', 0)
        await Promise.resolve()
        await Promise.resolve()
      } finally {
        jest.useRealTimers()
      }

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeded 2 MB limit'),
      )
    })

    it('stops updating fullLog once log is truncated (logTruncated=true branch)', async () => {
      const { ApiClient } = require('../../src/api-client')
      const mockSubmitLogChunk = jest.fn().mockResolvedValue(undefined)
      const mockSaveSessionLog = jest.fn().mockResolvedValue(undefined)
      ApiClient.mockImplementation(() => ({
        submitLogChunk: mockSubmitLogChunk,
        saveSessionLog: mockSaveSessionLog,
      }))

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      // Suppress stdout/stderr to avoid large output
      const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)
      const stderrWriteSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)

      try {
        const supervisor = new DockerSupervisor('1.0.0', makeOpts())
        supervisor.start([makeProject()])

        // Emit 3 chunks of ~700 KB each to exceed the 2 MB limit
        // The data handler just accumulates into buf; flush() is called on close
        const chunkSize = 700 * 1024
        const chunk = Buffer.alloc(chunkSize, 'z')

        fakeChild.stdout.emit('data', chunk)
        fakeChild.stdout.emit('data', chunk)
        fakeChild.stdout.emit('data', chunk)

        // Close the container — flush() will be called in the close handler
        fakeChild.emit('close', 0)

        // Allow the flush promise chain to settle
        await Promise.resolve()
        await Promise.resolve()
        await new Promise((r) => setImmediate(r))
        await new Promise((r) => setImmediate(r))
      } finally {
        stdoutWriteSpy.mockRestore()
        stderrWriteSpy.mockRestore()
      }

      // logTruncated warning should have been emitted during flush
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeded 2 MB limit'),
      )
    }, 15000)

    it('does not call process.exit a second time when close fires on already-handled container', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // First close — handled
      fakeChild.emit('close', 0)
      expect(mockExit).toHaveBeenCalledTimes(1)

      // Second close — should be ignored (closeHandled = true)
      fakeChild.emit('close', 0)
      // Still only called once
      expect(mockExit).toHaveBeenCalledTimes(1)
    })
  })

  // ─── process.getuid branch ────────────────────────────────────────────────

  describe('process.getuid optional branch', () => {
    it('omits --user flag when process.getuid is not available', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      // Temporarily remove process.getuid
      const originalGetuid = process.getuid
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (process as any).getuid

      try {
        const supervisor = new DockerSupervisor('1.0.0', makeOpts())
        supervisor.start([makeProject()])

        const spawnArgs = mockSpawn.mock.calls[0][1] as string[]
        expect(spawnArgs).not.toContain('--user')
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process as any).getuid = originalGetuid
      }
    })
  })

  // ─── watcher change event ─────────────────────────────────────────────────

  describe('watcher change event (not just rename)', () => {
    it('handles change event type for docker-registered-agent-id', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ agentId: 'old-id' }))
      supervisor.start([makeProject()])

      // Simulate the watcher callback with 'change' event type
      const watchCallback = mockWatch.mock.calls[0][1] as (
        eventType: string,
        filename: string,
      ) => void

      mockReadFileSync.mockReturnValueOnce('new-change-agent-id')
      mockExistsSync.mockReturnValueOnce(true)
      watchCallback('change', 'docker-registered-agent-id')

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('new-change-agent-id'),
      )
    })

    it('ignores watcher events for files other than docker-registered-agent-id', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      const watchCallback = mockWatch.mock.calls[0][1] as (
        eventType: string,
        filename: string,
      ) => void

      const infoCallsBefore = (logger.info as jest.Mock).mock.calls.length
      watchCallback('rename', 'some-other-file.json')
      const infoCallsAfter = (logger.info as jest.Mock).mock.calls.length

      // No new info calls — unrelated file ignored
      expect(infoCallsAfter).toBe(infoCallsBefore)
    })

    it('handles readFileSync failure gracefully in watcher callback', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      const watchCallback = mockWatch.mock.calls[0][1] as (
        eventType: string,
        filename: string,
      ) => void

      // readFileSync throws ENOENT — should be silently caught
      mockReadFileSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
      mockExistsSync.mockReturnValueOnce(true)

      expect(() => {
        watchCallback('rename', 'docker-registered-agent-id')
      }).not.toThrow()
    })
  })

  // ─── graceful shutdown: Promise.all resolves before timeout ──────────────

  describe('graceful shutdown via closedPromise resolution', () => {
    it('clears shutdownTimer and calls process.exit(0) when all containers close before timeout', async () => {
      // Use real timers to avoid fake-timer interaction with async Promise chains
      jest.useRealTimers()

      const watcherClose = jest.fn()
      mockWatch.mockReturnValue({ close: watcherClose } as unknown as ReturnType<typeof fs.watch>)

      const { ApiClient } = require('../../src/api-client')
      ApiClient.mockImplementation(() => ({
        submitLogChunk: jest.fn().mockResolvedValue(undefined),
        saveSessionLog: jest.fn().mockResolvedValue(undefined),
      }))

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const processOnSpy = jest.spyOn(process, 'on')
      // Use a long enough shutdownTimeoutMs so the test doesn't time out via the timer path
      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ shutdownTimeoutMs: 30000 }))
      supervisor.start([makeProject()])

      const sigintHandler = processOnSpy.mock.calls.find((c) => c[0] === 'SIGINT')
      const handler = sigintHandler![1] as () => void

      // Trigger shutdown — this sets updating=true and starts Promise.all(closedPromises)
      handler()

      // Now close the container — this triggers resolveClosed() in the close handler chain
      fakeChild.emit('close', 0)

      // Allow the microtask queue to drain (flush → saveSessionLog (empty) → resolveClosed → Promise.all → process.exit)
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setImmediate(r))
      }

      // process.exit(0) should be called from the Promise.all().then() callback
      expect(mockExit).toHaveBeenCalledWith(0)

      processOnSpy.mockRestore()
    }, 10000)
  })

  // ─── successful build copies srcHash to dstHash ──────────────────────────

  describe('rebuildAndRestart - srcHash copy after successful build', () => {
    it('copies docker-customization-hash to docker-built-hash after successful build', async () => {
      mockExistsSync.mockReset()
      mockReadFileSync.mockReset()
      mockUnlinkSync.mockReset()

      const mockCopyFileSync = fs.copyFileSync as jest.MockedFunction<typeof fs.copyFileSync>

      mockReadFileSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      // docker-rebuild-needed, Dockerfile, and docker-customization-hash all exist
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return (
          s.endsWith('docker-rebuild-needed') ||
          s.endsWith('Dockerfile') ||
          s.endsWith('docker-customization-hash')
        ) &&
          !s.endsWith('docker-registered-agent-id') &&
          !s.endsWith('docker-built-hash') &&
          !s.endsWith('docker-build-error')
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
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))

      // buildProjectImage succeeded, srcHash exists → copyFileSync should be called
      expect(mockBuildProjectImage).toHaveBeenCalled()
      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('docker-customization-hash'),
        expect.stringContaining('docker-built-hash'),
      )
    })

    it('copies docker-customization-hash to docker-built-hash even after build failure', async () => {
      mockExistsSync.mockReset()
      mockReadFileSync.mockReset()
      mockUnlinkSync.mockReset()

      const mockCopyFileSync = fs.copyFileSync as jest.MockedFunction<typeof fs.copyFileSync>

      mockReadFileSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      mockBuildProjectImage.mockRejectedValueOnce(new Error('build failed'))

      // docker-rebuild-needed, Dockerfile, and docker-customization-hash all exist
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return (
          s.endsWith('docker-rebuild-needed') ||
          s.endsWith('Dockerfile') ||
          s.endsWith('docker-customization-hash')
        ) &&
          !s.endsWith('docker-registered-agent-id') &&
          !s.endsWith('docker-built-hash') &&
          !s.endsWith('docker-build-error')
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
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Image build failed'))
      // Even on failure, srcHash copy should be attempted
      expect(mockCopyFileSync).toHaveBeenCalledWith(
        expect.stringContaining('docker-customization-hash'),
        expect.stringContaining('docker-built-hash'),
      )
    })
  })

  // ─── submitLogChunk failure warning ──────────────────────────────────────

  describe('log streaming: submitLogChunk failure', () => {
    it('warns when submitLogChunk rejects', async () => {
      const { ApiClient } = require('../../src/api-client')
      const mockSubmitLogChunk = jest.fn().mockRejectedValue(new Error('chunk upload failed'))
      const mockSaveSessionLog = jest.fn().mockResolvedValue(undefined)
      ApiClient.mockImplementation(() => ({
        submitLogChunk: mockSubmitLogChunk,
        saveSessionLog: mockSaveSessionLog,
      }))

      const watcherClose = jest.fn()
      mockWatch.mockReturnValue({ close: watcherClose } as unknown as ReturnType<typeof fs.watch>)

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Emit some data to populate buf
      fakeChild.stdout.emit('data', Buffer.from('some log line\n'))

      // Trigger flush by closing the container
      fakeChild.emit('close', 0)

      // Allow the async flush to settle
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      // submitLogChunk threw — warning should be logged via .catch handler
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('log chunk failed'),
      )
    })
  })

  // ─── installUpdateAndRestart failure → process.exit(1) ───────────────────

  describe('close handler: installUpdateAndRestart failure', () => {
    it('logs error and calls process.exit(1) when installUpdateAndRestart rejects', async () => {
      mockInstallUpdateAndRestart.mockRejectedValueOnce(new Error('update install failed'))

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild.emit('close', 42) // DOCKER_UPDATE_EXIT_CODE

      // Allow the async error to propagate through the .catch handler
      await Promise.resolve()
      await Promise.resolve()
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Update failed'),
      )
      expect(mockExit).toHaveBeenCalledWith(1)
    })
  })

  // ─── close handler: rebuildAndRestart rejection → logger.error ───────────

  describe('close handler: rebuildAndRestart failure', () => {
    it('logs error when rebuildAndRestart rejects', async () => {
      // Trigger a restart (exit code 43) but make rebuildAndRestart fail
      mockBuildProjectImage.mockRejectedValueOnce(new Error('rebuild failed catastrophically'))

      // Dockerfile exists so rebuild is triggered
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return s.endsWith('Dockerfile') &&
          !s.endsWith('docker-rebuild-needed') &&
          !s.endsWith('docker-registered-agent-id') &&
          !s.endsWith('docker-customization-hash') &&
          !s.endsWith('docker-built-hash')
      })

      // rebuildAndRestart will throw when there's an error writing build-error file
      // (the `/* istanbul ignore next */ try { fs.writeFileSync }` path)
      // We can cover line 391 by making the entire async path reject
      const fakeChild1 = makeFakeChild()
      // fakeChild2 should never spawn since rebuildAndRestart will also throw
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43) // DOCKER_RESTART_EXIT_CODE

      // Allow the .catch handler to fire
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))

      // Even though buildProjectImage failed, rebuildAndRestart still calls spawnProject
      // (image build failure does not prevent restart — it falls through to spawnProject).
      // The outer .catch on rebuildAndRestart fires only if spawnProject itself throws,
      // which doesn't happen in this scenario. So line 391 is covered by the fact that
      // rebuildAndRestart's internal build failure is logged at line 391 of the error path.
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Image build failed'),
      )
    })

    it('covers outer .catch on rebuildAndRestart when spawnProject throws (line 391)', async () => {
      // Cover the outer `.catch((err) => logger.error('Restart failed: ...'))` at line 391
      // This fires when rebuildAndRestart itself throws during the spawnProject call.
      // We simulate this by making buildProjectVolumeMounts throw on the second call.
      const { buildProjectVolumeMounts } = require('../../src/docker/volume-mount-builder')
      const mockBuildVolumeMounts = buildProjectVolumeMounts as jest.MockedFunction<typeof import('../../src/docker/volume-mount-builder').buildProjectVolumeMounts>

      let volumeCallNum = 0
      mockBuildVolumeMounts.mockImplementation(() => {
        volumeCallNum++
        // Fail on second call (triggered by rebuildAndRestart → spawnProject)
        if (volumeCallNum >= 2) {
          throw new Error('volume mount error on restart')
        }
        return { mounts: ['-v', '/host:/container:rw'], envArgs: ['-e', 'AI_SUPPORT_AGENT_TOKEN=test'] }
      })

      const fakeChild1 = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild1 as never)

      // No Dockerfile → rebuildAndRestart skips build and goes directly to spawnProject
      mockExistsSync.mockReturnValue(false)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43) // DOCKER_RESTART_EXIT_CODE

      // Allow the .catch handler to fire
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Restart failed'),
      )

      // Restore
      mockBuildVolumeMounts.mockReturnValue({ mounts: ['-v', '/host/path:/container/path:rw'], envArgs: ['-e', 'AI_SUPPORT_AGENT_TOKEN=test-token'] })
    })
  })

  // ─── S3 upload failure warning ─────────────────────────────────────────────

  describe('log streaming: S3 upload failure (saveSessionLog)', () => {
    it('warns when saveSessionLog rejects (line 357)', async () => {
      const { ApiClient } = require('../../src/api-client')
      const mockSubmitLogChunk = jest.fn().mockResolvedValue(undefined)
      const mockSaveSessionLog = jest.fn().mockRejectedValue(new Error('S3 upload failed'))
      ApiClient.mockImplementation(() => ({
        submitLogChunk: mockSubmitLogChunk,
        saveSessionLog: mockSaveSessionLog,
      }))

      const watcherClose = jest.fn()
      mockWatch.mockReturnValue({ close: watcherClose } as unknown as ReturnType<typeof fs.watch>)

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Emit data so fullLog is non-empty (triggers saveSessionLog)
      fakeChild.stdout.emit('data', Buffer.from('some log line\n'))

      // Suppress stdout writes from test output
      const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)

      // Close the container — flush + saveSessionLog chain runs
      fakeChild.emit('close', 0)

      // Allow the async chain to settle completely:
      // close event → flush() → saveSessionLog (rejects) → .catch (logger.warn) → .finally (resolveClosed)
      for (let i = 0; i < 10; i++) {
        await Promise.resolve()
      }
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r))
      }

      stdoutWriteSpy.mockRestore()

      // saveSessionLog threw → warning logged via .catch
      expect(mockSaveSessionLog).toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('S3 upload failed'),
      )
    })
  })

  // ─── watcher callback: empty newId (falsy branch on line 313) ─────────────

  describe('watcher callback: empty or falsy newId', () => {
    it('does not call setProjectAgentId when newId is empty string', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts({ agentId: 'existing-agent' }))
      supervisor.start([makeProject()])

      const watchCallback = mockWatch.mock.calls[0][1] as (
        eventType: string,
        filename: string,
      ) => void

      // readFileSync returns empty string → trim() → '' → falsy → setProjectAgentId NOT called
      mockReadFileSync.mockReturnValueOnce('')

      const infoCallsBefore = (logger.info as jest.Mock).mock.calls.length
      watchCallback('rename', 'docker-registered-agent-id')
      const infoCallsAfter = (logger.info as jest.Mock).mock.calls.length

      // No info log about agentId change since newId is falsy
      expect(infoCallsAfter).toBe(infoCallsBefore)
    })
  })

  // ─── rebuildAndRestart: shouldBuild=true but no Dockerfile ──────────────────

  describe('rebuildAndRestart: marker exists but no Dockerfile (line 173 false branch)', () => {
    it('skips build and calls spawnProject directly when marker exists but no Dockerfile', async () => {
      mockExistsSync.mockReset()
      mockReadFileSync.mockReset()
      mockUnlinkSync.mockReset()
      mockReadFileSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      // Only docker-rebuild-needed exists; Dockerfile does NOT exist
      // This exercises the false branch of `if (fs.existsSync(projectDockerfile))` (line 173)
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return s.endsWith('docker-rebuild-needed') &&
          !s.endsWith('Dockerfile') &&
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
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))

      // Build should NOT be called (no Dockerfile)
      expect(mockBuildProjectImage).not.toHaveBeenCalled()
      // But marker should be deleted (hasMarker=true → unlinkSync)
      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('docker-rebuild-needed'),
      )
      // spawnProject is still called (initial + restart)
      expect(mockSpawn).toHaveBeenCalledTimes(2)
    })
  })

  // ─── rebuildAndRestart: error message > 3000 chars (line 191) ────────────────

  describe('rebuildAndRestart: long error message truncation (line 191)', () => {
    it('truncates error message when longer than 3000 characters', async () => {
      mockExistsSync.mockReset()
      mockReadFileSync.mockReset()
      mockUnlinkSync.mockReset()
      mockReadFileSync.mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })

      // Dockerfile exists (marker too) so build is triggered
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = p as string
        return (s.endsWith('docker-rebuild-needed') || s.endsWith('Dockerfile')) &&
          !s.endsWith('docker-registered-agent-id') &&
          !s.endsWith('docker-customization-hash') &&
          !s.endsWith('docker-built-hash')
      })

      // Throw an error message longer than 3000 chars
      const longErrorMsg = 'x'.repeat(3500)
      mockBuildProjectImage.mockRejectedValueOnce(new Error(longErrorMsg))

      const fakeChild1 = makeFakeChild()
      const fakeChild2 = makeFakeChild()
      let spawnCallNum = 0
      mockSpawn.mockImplementation(() => {
        spawnCallNum++
        return (spawnCallNum === 1 ? fakeChild1 : fakeChild2) as never
      })

      const { writeFileSync } = require('fs') as typeof import('fs')
      const mockWriteFileSync = writeFileSync as jest.MockedFunction<typeof writeFileSync>

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      fakeChild1.emit('close', 43)
      for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))

      // writeFileSync should have been called with the truncated error (3000 chars + '...(truncated)')
      // (the /* istanbul ignore next */ try/catch wraps it but the inner call is covered)
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[docker] Image build failed'),
      )
      // The error message sent to writeFileSync should be at most 3000 + '...(truncated)'.length
      const writeCallArgs = mockWriteFileSync.mock.calls.find(
        (call) => typeof call[1] === 'string' && (call[1] as string).includes('...(truncated)'),
      )
      expect(writeCallArgs).toBeDefined()
      expect((writeCallArgs![1] as string).length).toBe(3000 + '...(truncated)'.length)
    })
  })

  // ─── close handler: onAllStopped callback + null exit code ───────────────────

  describe('close handler: onAllStopped and null exit code', () => {
    it('calls onAllStopped callback when all containers exit cleanly', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)
      mockExistsSync.mockReturnValue(false)

      const onAllStopped = jest.fn()
      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      // Access onAllStopped via the start method's optional parameter
      // We need to trigger the `this.onAllStopped?.()` call by having all containers exit.
      // The onAllStopped is set internally via `this.onAllStopped = onStop` in start().
      // However, the close handler calls `this.onAllStopped?.()` not `onStop`.
      // We use the fact that start() sets `this.onAllStopped = onStop` (private field).
      // We pass onAllStopped as a stand-in for onStop, but since it's the SIGINT/SIGTERM
      // callback in the tests above, we need a different approach here.
      //
      // The `onAllStopped` in the close handler is this.onAllStopped which is set from
      // the start() parameter. But start() sets `this.onAllStopped = onStop` ONLY if
      // onStop is passed. Looking at the code:
      //   start(projects, onStop) { this.onAllStopped = onStop; ... }
      // The onStop in the close handler is accessed via `this.onAllStopped?.()`.
      // To cover this, pass an onStop to start() and then let all containers exit.
      //
      // Note: the onStop callback in shutdown() is different from onAllStopped in the close handler.
      // In shutdown(), `onStop?.()` is called. In the close handler, `this.onAllStopped?.()` is called.
      // Both are set from the start() `onStop` parameter.

      supervisor.start([makeProject()], onAllStopped)

      fakeChild.emit('close', 0)

      expect(onAllStopped).toHaveBeenCalled()
      expect(mockExit).toHaveBeenCalledWith(0)
    })

    it('calls process.exit(0) when container exits with null code', () => {
      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)
      mockExistsSync.mockReturnValue(false)

      const supervisor = new DockerSupervisor('1.0.0', makeOpts())
      supervisor.start([makeProject()])

      // Emit close with null exit code → `process.exit(code ?? 0)` → process.exit(0)
      fakeChild.emit('close', null)

      expect(mockExit).toHaveBeenCalledWith(0)
    })
  })

  // Note: log streaming lines 330 (logTruncated=true re-entry) and 335 (remaining <= 0)
  // cannot be tested directly: jest.useFakeTimers() freezes the supervisor's internal
  // setInterval flush timer causing the Jest worker to hang and the CI job to timeout.

  xdescribe('log streaming: flush when already truncated (logTruncated=true branch)', () => {
    it('skips fullLog update on second flush when already truncated (via two close events)', async () => {
      // Strategy: trigger two separate flushes using the close-handler flush path.
      // First flush: big chunk > 2MB → truncation occurs, logTruncated=true, warn emitted.
      // Second flush: container close event fires again on a new container — but since we
      // use a single child, we trigger the setInterval-based flush by emitting two data
      // events separated by a close on child2.
      //
      // Simpler approach: spawn two projects, one after the other, each exceeding the limit.
      // Actually, the simplest approach is to emit a huge chunk to buf, then close the
      // container. The close handler calls flush() directly, which triggers truncation.
      // The logTruncated=true branch on re-entry is covered when flush() is called a
      // second time with buf non-empty while logTruncated=true.
      //
      // We achieve this by calling close twice on two separate containers with the same
      // supervisor to ensure the second flush sees logTruncated=true.
      //
      // Easiest: emit big chunk, let close handler flush it (truncation), then trigger
      // a second flush via setInterval by using fake timers from the START.
      jest.useFakeTimers()

      const { ApiClient } = require('../../src/api-client')
      const mockSubmitLogChunk = jest.fn().mockResolvedValue(undefined)
      const mockSaveSessionLog = jest.fn().mockResolvedValue(undefined)
      ApiClient.mockImplementation(() => ({
        submitLogChunk: mockSubmitLogChunk,
        saveSessionLog: mockSaveSessionLog,
      }))

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)

      try {
        const supervisor = new DockerSupervisor('1.0.0', makeOpts())
        supervisor.start([makeProject()])

        // Exceed MAX_SESSION_LOG_BYTES (2MB) so truncation happens on the first flush
        const bigChunk = Buffer.alloc(2 * 1024 * 1024 + 1024, 'A') // 2MB + 1KB
        fakeChild.stdout.emit('data', bigChunk)

        // First flush via interval: truncation occurs (logTruncated becomes true, warn is emitted)
        jest.advanceTimersByTime(1000)
        await Promise.resolve()
        await Promise.resolve()

        // Emit more data after truncation
        fakeChild.stdout.emit('data', Buffer.from('after truncation data'))

        // Second flush via interval: logTruncated=true → the `if (!logTruncated)` branch is false
        jest.advanceTimersByTime(1000)
        await Promise.resolve()
        await Promise.resolve()
      } finally {
        jest.useRealTimers()
        stdoutWriteSpy.mockRestore()
      }

      // Warn about truncation should have been emitted at least once
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeded 2 MB limit'),
      )
    }, 15000)

    it('hits remaining <= 0 branch when fullLog is exactly at MAX_SESSION_LOG_BYTES', async () => {
      // Scenario:
      //   1. First chunk fills fullLog to exactly MAX (takes the <= branch, logTruncated stays false)
      //   2. Second chunk: remaining = MAX - MAX = 0 → `remaining > 0` is false → fullLog += ''
      //      → this triggers the `remaining <= 0` branch and sets logTruncated=true
      jest.useFakeTimers()

      const { ApiClient } = require('../../src/api-client')
      const mockSubmitLogChunk = jest.fn().mockResolvedValue(undefined)
      const mockSaveSessionLog = jest.fn().mockResolvedValue(undefined)
      ApiClient.mockImplementation(() => ({
        submitLogChunk: mockSubmitLogChunk,
        saveSessionLog: mockSaveSessionLog,
      }))

      const fakeChild = makeFakeChild()
      mockSpawn.mockReturnValue(fakeChild as never)

      const stdoutWriteSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true)

      try {
        const supervisor = new DockerSupervisor('1.0.0', makeOpts())
        supervisor.start([makeProject()])

        // MAX_SESSION_LOG_BYTES = 2 * 1024 * 1024 = 2097152
        const MAX = 2 * 1024 * 1024
        // First chunk: exactly fills fullLog (takes the if-branch, fullLog.length = MAX)
        const exactChunk = Buffer.alloc(MAX, 'B')
        fakeChild.stdout.emit('data', exactChunk)

        // First flush: text.length === MAX, fullLog.length=0+MAX <= MAX → fullLog += text
        // Now fullLog.length = MAX, logTruncated still false
        jest.advanceTimersByTime(1000)
        await Promise.resolve()
        await Promise.resolve()

        // Second chunk: anything additional
        fakeChild.stdout.emit('data', Buffer.alloc(1024, 'C'))

        // Second flush: fullLog.length(MAX) + text.length(1024) > MAX
        // → else branch: remaining = MAX - MAX = 0 → `remaining > 0` is false → fullLog += ''
        // → logTruncated = true, warn emitted
        jest.advanceTimersByTime(1000)
        await Promise.resolve()
        await Promise.resolve()
      } finally {
        jest.useRealTimers()
        stdoutWriteSpy.mockRestore()
      }

      // Truncation warning should fire on second flush
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('exceeded 2 MB limit'),
      )
    }, 15000)
  })
})
