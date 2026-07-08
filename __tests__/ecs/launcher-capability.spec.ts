/**
 * Tests for src/ecs/launcher-capability.ts
 *
 * The ecs_launch capability must be advertised only when AWS credentials are
 * resolvable (default provider chain) or when force-enabled via the
 * AI_SUPPORT_AGENT_ECS_LAUNCHER override.
 */

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

const mockProvider = jest.fn()
const mockFromNodeProviderChain = jest.fn(() => mockProvider)
jest.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: (...args: unknown[]) => mockFromNodeProviderChain(...args),
}))

import {
  detectEcsLauncherCapability,
  resetEcsLauncherCapabilityCache,
} from '../../src/ecs/launcher-capability'
import { logger } from '../../src/logger'

const ENV_NAME = 'AI_SUPPORT_AGENT_ECS_LAUNCHER'

beforeEach(() => {
  jest.clearAllMocks()
  resetEcsLauncherCapabilityCache()
  mockProvider.mockResolvedValue({ accessKeyId: 'AKIA_TEST', secretAccessKey: 's' })
})

describe('detectEcsLauncherCapability', () => {
  it('returns true when credentials resolve and logs the decision', async () => {
    const result = await detectEcsLauncherCapability({})

    expect(result).toBe(true)
    expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(
      '[ecs] AWS credentials resolved; advertising ecs_launch capability',
    )
  })

  it('returns false when credential resolution rejects', async () => {
    mockProvider.mockRejectedValue(new Error('Could not load credentials from any providers'))

    const result = await detectEcsLauncherCapability({})

    expect(result).toBe(false)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('AWS credentials not resolvable'),
    )
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[ecs] ecs_launch capability not advertised (no resolvable AWS credentials'),
    )
  })

  it('returns false when resolution exceeds the timeout', async () => {
    mockProvider.mockImplementation(() => new Promise(() => {})) // never resolves

    const result = await detectEcsLauncherCapability({}, 20)

    expect(result).toBe(false)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('credential resolution timed out after 20ms'),
    )
  })

  it('returns false when resolved credentials have no accessKeyId', async () => {
    mockProvider.mockResolvedValue({ accessKeyId: '', secretAccessKey: 's' })

    const result = await detectEcsLauncherCapability({})

    expect(result).toBe(false)
  })

  it('force-disables via env override without probing credentials', async () => {
    const result = await detectEcsLauncherCapability({ [ENV_NAME]: 'false' })

    expect(result).toBe(false)
    expect(mockFromNodeProviderChain).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`${ENV_NAME}=false`),
    )
  })

  it('force-enables via env override without probing credentials', async () => {
    mockProvider.mockRejectedValue(new Error('no creds')) // would fail if probed

    const result = await detectEcsLauncherCapability({ [ENV_NAME]: 'true' })

    expect(result).toBe(true)
    expect(mockFromNodeProviderChain).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`${ENV_NAME}=true`),
    )
  })

  it('caches only a positive detection for the process lifetime', async () => {
    expect(await detectEcsLauncherCapability({})).toBe(true)
    expect(await detectEcsLauncherCapability({})).toBe(true)
    expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(1)
  })

  it('re-probes after a negative result so late-arriving credentials are picked up', async () => {
    // Cold start: first probe times out / fails -> negative, must NOT be sticky.
    mockProvider.mockRejectedValueOnce(new Error('IMDS timeout'))
    expect(await detectEcsLauncherCapability({})).toBe(false)

    // Second registration attempt: credentials are now available.
    mockProvider.mockResolvedValue({ accessKeyId: 'AKIA_LATE', secretAccessKey: 's' })
    expect(await detectEcsLauncherCapability({})).toBe(true)

    // A subsequent call is served from the positive cache (no third probe).
    expect(await detectEcsLauncherCapability({})).toBe(true)
    expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(2)
  })

  it('re-probes after the cache is reset', async () => {
    await detectEcsLauncherCapability({})
    resetEcsLauncherCapabilityCache()
    await detectEcsLauncherCapability({})

    expect(mockFromNodeProviderChain).toHaveBeenCalledTimes(2)
  })

  it('env override takes precedence over a confirmed positive detection', async () => {
    expect(await detectEcsLauncherCapability({})).toBe(true) // cached true
    expect(await detectEcsLauncherCapability({ [ENV_NAME]: 'false' })).toBe(false)
  })
})
