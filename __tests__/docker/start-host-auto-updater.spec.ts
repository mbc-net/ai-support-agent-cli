/**
 * Tests for startHostAutoUpdater().
 *
 * Validates that:
 * - auto-updater is started with the correct config when enabled
 * - auto-updater is NOT started when disabled via --no-auto-update or config
 * - auto-updater is NOT started when no projects exist
 * - auto-updater is NOT started when the first project lacks apiUrl/token
 * - the stopAllAgents callback forwards to supervisor.stopAll()
 * - the error reporter sends a heartbeat with the error message
 *
 * Reason: Docker mode containers skip auto-update via the
 * AI_SUPPORT_AGENT_IN_DOCKER guard in auto-updater.ts. The host process must
 * run the updater on their behalf so a new version is installed automatically.
 */

jest.mock('../../src/api-client', () => ({
  ApiClient: jest.fn().mockImplementation((apiUrl: string, token: string) => ({
    apiUrl,
    token,
    heartbeat: jest.fn().mockResolvedValue(undefined),
  })),
}))

jest.mock('../../src/auto-updater', () => ({
  startAutoUpdater: jest.fn().mockReturnValue({ stop: jest.fn() }),
}))

jest.mock('../../src/system-info', () => ({
  getSystemInfo: jest.fn(() => ({ platform: 'linux', arch: 'x64' })),
}))

jest.mock('../../src/cli/validators', () => ({
  validateUpdateChannel: jest.fn((channel: string) => channel),
}))

jest.mock('../../src/update-checker', () => ({
  detectChannelFromVersion: jest.fn(() => 'latest'),
}))

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

import { ApiClient } from '../../src/api-client'
import { startAutoUpdater } from '../../src/auto-updater'
import { startHostAutoUpdater } from '../../src/docker/docker-runner'
import type { DockerSupervisor } from '../../src/docker/docker-supervisor'

const mockApiClientCtor = ApiClient as unknown as jest.Mock
const mockStartAutoUpdater = startAutoUpdater as jest.MockedFunction<typeof startAutoUpdater>

function makeSupervisor(): Pick<DockerSupervisor, 'stopAll'> & { stopAll: jest.Mock } {
  return { stopAll: jest.fn() }
}

const baseProjects = [
  {
    tenantCode: '00000001',
    projectCode: 'PROJ_A',
    token: 'test-token',
    apiUrl: 'https://api.example.com',
  },
]

describe('startHostAutoUpdater', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('starts the auto-updater when enabled with at least one project', () => {
    const supervisor = makeSupervisor()
    const handle = startHostAutoUpdater(
      { autoUpdate: true, updateChannel: 'latest' },
      null,
      baseProjects,
      supervisor,
      'agent-1',
    )

    expect(handle).toBeDefined()
    expect(mockStartAutoUpdater).toHaveBeenCalledTimes(1)
    const [clients, config, stopAll, errorReporter] = mockStartAutoUpdater.mock.calls[0]
    expect(clients).toHaveLength(1)
    expect(config.enabled).toBe(true)
    expect(typeof stopAll).toBe('function')
    expect(typeof errorReporter).toBe('function')
  })

  it('uses the first project apiUrl/token to construct the API client', () => {
    const supervisor = makeSupervisor()
    startHostAutoUpdater(
      { autoUpdate: true },
      null,
      baseProjects,
      supervisor,
      'agent-1',
    )

    expect(mockApiClientCtor).toHaveBeenCalledWith(
      'https://api.example.com',
      'test-token',
    )
  })

  it('returns undefined and skips startup when auto-update is disabled', () => {
    const supervisor = makeSupervisor()
    const handle = startHostAutoUpdater(
      { autoUpdate: false },
      null,
      baseProjects,
      supervisor,
      'agent-1',
    )

    expect(handle).toBeUndefined()
    expect(mockStartAutoUpdater).not.toHaveBeenCalled()
  })

  it('returns undefined when no projects are provided', () => {
    const supervisor = makeSupervisor()
    const handle = startHostAutoUpdater(
      { autoUpdate: true },
      null,
      [],
      supervisor,
      'agent-1',
    )

    expect(handle).toBeUndefined()
    expect(mockStartAutoUpdater).not.toHaveBeenCalled()
  })

  it('returns undefined when first project lacks apiUrl or token', () => {
    const supervisor = makeSupervisor()
    const missingApi = [
      { tenantCode: '00000001', projectCode: 'PROJ_A', token: 'test-token', apiUrl: '' },
    ]
    const handle = startHostAutoUpdater(
      { autoUpdate: true },
      null,
      missingApi,
      supervisor,
      'agent-1',
    )

    expect(handle).toBeUndefined()
    expect(mockStartAutoUpdater).not.toHaveBeenCalled()
  })

  it('stopAllAgents callback forwards to supervisor.stopAll()', () => {
    const supervisor = makeSupervisor()
    startHostAutoUpdater(
      { autoUpdate: true },
      null,
      baseProjects,
      supervisor,
      'agent-1',
    )

    const [, , stopAll] = mockStartAutoUpdater.mock.calls[0]
    stopAll()

    expect(supervisor.stopAll).toHaveBeenCalledTimes(1)
  })

  it('error reporter sends a heartbeat carrying the error message', async () => {
    const supervisor = makeSupervisor()
    startHostAutoUpdater(
      { autoUpdate: true },
      null,
      baseProjects,
      supervisor,
      'agent-1',
    )

    const [, , , errorReporter] = mockStartAutoUpdater.mock.calls[0]
    expect(errorReporter).toBeDefined()
    errorReporter!('boom')

    // The ApiClient mock returns the constructed instance; grab it via the constructor
    const instance = mockApiClientCtor.mock.results[0].value
    expect(instance.heartbeat).toHaveBeenCalledWith(
      'agent-1',
      expect.any(Object),
      'boom',
    )
  })

  it('falls back to config.agentId when no agentId is provided', () => {
    const supervisor = makeSupervisor()
    startHostAutoUpdater(
      { autoUpdate: true },
      { agentId: 'config-agent', autoUpdate: undefined },
      baseProjects,
      supervisor,
      undefined,
    )

    const [, , , errorReporter] = mockStartAutoUpdater.mock.calls[0]
    errorReporter!('err')

    const instance = mockApiClientCtor.mock.results[0].value
    expect(instance.heartbeat).toHaveBeenCalledWith(
      'config-agent',
      expect.any(Object),
      'err',
    )
  })
})
