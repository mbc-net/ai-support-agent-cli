/**
 * Tests for src/docker/image-registry.ts
 *
 * pullRegistryImage() replaces a ~hour-long local build with a pull, so its
 * contract matters in both directions: it must leave behind exactly the local
 * tag the rest of the CLI expects on success, and it must report failure (never
 * throw, never stay silent) so ensureImage() can fall back to a build.
 */

jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
}))

jest.mock('../../src/docker/docker-utils', () => ({
  IMAGE_NAME: 'ai-support-agent',
  getDockerPath: jest.fn(() => '/usr/local/bin/docker'),
  execErrorMessage: jest.fn((err: unknown) => (err as Error).message),
}))

jest.mock('../../src/i18n', () => ({
  t: jest.fn((key: string) => key),
}))

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
  },
}))

import { execFileSync } from 'child_process'

import { PULL_TIMEOUT_MS, REGISTRY_IMAGE, TAG_TIMEOUT_MS, pullRegistryImage } from '../../src/docker/image-registry'
import { logger } from '../../src/logger'

const mockExecFileSync = execFileSync as jest.MockedFunction<typeof execFileSync>
const mockLogger = logger as jest.Mocked<typeof logger>

/** docker argv of every call whose first argument matches `verb`. */
function callsFor(verb: string): string[][] {
  return mockExecFileSync.mock.calls
    .map((call) => call[1] as string[])
    .filter((args) => args?.[0] === verb)
}

/** execFileSync options of the first call whose docker verb matches. */
function optionsFor(verb: string): Record<string, unknown> {
  const call = mockExecFileSync.mock.calls.find((c) => (c[1] as string[])?.[0] === verb)
  return (call?.[2] ?? {}) as Record<string, unknown>
}

describe('image-registry', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExecFileSync.mockReturnValue(Buffer.from(''))
  })

  describe('REGISTRY_IMAGE', () => {
    it('points at the repository the release workflow publishes to', () => {
      // Must stay in sync with .github/workflows/ci-cd.yml (publish_image) and
      // manifest-generator.ts's DEFAULT_AGENT_IMAGE.
      expect(REGISTRY_IMAGE).toBe('ghcr.io/mbc-net/ai-support-agent-cli')
    })
  })

  describe('pullRegistryImage', () => {
    it('pulls the versioned tag and reports success', () => {
      const result = pullRegistryImage('1.2.3')

      expect(result).toBe(true)
      expect(callsFor('pull')).toEqual([['pull', 'ghcr.io/mbc-net/ai-support-agent-cli:1.2.3']])
      expect(mockLogger.success).toHaveBeenCalledWith('docker.pullComplete')
    })

    it('tags the pulled image with the local name every other code path uses', () => {
      pullRegistryImage('1.2.3')

      // Per-project images (FROM ai-support-agent:<version>), DockerSupervisor
      // and the service wrappers all reference the local name, never the
      // registry ref.
      expect(callsFor('tag')).toEqual([
        ['tag', 'ghcr.io/mbc-net/ai-support-agent-cli:1.2.3', 'ai-support-agent:1.2.3'],
      ])
    })

    it('untags the registry reference so pruning can reclaim superseded versions', () => {
      pullRegistryImage('1.2.3')

      // pruneOldImages() only sweeps the ai-support-agent repository. A leftover
      // ghcr.io tag would keep an old image ID alive and the disk would never
      // be reclaimed.
      expect(callsFor('rmi')).toEqual([['rmi', 'ghcr.io/mbc-net/ai-support-agent-cli:1.2.3']])
    })

    it('returns false with a warning when the pull fails (missing tag / offline)', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        if ((args as string[])?.[0] === 'pull') throw new Error('manifest unknown')
        return Buffer.from('')
      })

      const result = pullRegistryImage('9.9.9')

      expect(result).toBe(false)
      expect(mockLogger.warn).toHaveBeenCalledWith('docker.pullFailed')
      // Nothing was tagged, so ensureImage() cannot mistake a failed pull for a
      // usable local image.
      expect(callsFor('tag')).toEqual([])
    })

    it('returns false when tagging fails, so the caller builds instead', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        if ((args as string[])?.[0] === 'tag') throw new Error('invalid reference format')
        return Buffer.from('')
      })

      expect(pullRegistryImage('1.2.3')).toBe(false)
      // Reported as a tag failure, not a pull failure: the pull succeeded, and
      // saying otherwise sends troubleshooting after the wrong problem.
      expect(mockLogger.warn).toHaveBeenCalledWith('docker.tagFailed')
      expect(mockLogger.warn).not.toHaveBeenCalledWith('docker.pullFailed')
    })

    it('removes the downloaded image when tagging fails, instead of leaking multiple GB', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        if ((args as string[])?.[0] === 'tag') throw new Error('invalid reference format')
        return Buffer.from('')
      })

      pullRegistryImage('1.2.3')

      // The registry ref is the only reference to the pulled layers at this
      // point, and pruneOldImages() never looks at that repository — without
      // this cleanup the download is stranded on disk forever.
      expect(callsFor('rmi')).toEqual([['rmi', 'ghcr.io/mbc-net/ai-support-agent-cli:1.2.3']])
    })

    it('bounds the pull so a stalled connection cannot block startup forever', () => {
      pullRegistryImage('1.2.3')

      // Nothing else can rescue a hung pull: the build fallback only runs when
      // the pull *fails*.
      expect(optionsFor('pull').timeout).toBe(PULL_TIMEOUT_MS)
      expect(optionsFor('tag').timeout).toBe(TAG_TIMEOUT_MS)
      expect(optionsFor('rmi').timeout).toBe(TAG_TIMEOUT_MS)
    })

    it('captures stderr of tag/rmi so the warning carries docker\'s actual reason', () => {
      pullRegistryImage('1.2.3')

      // execErrorMessage() prefers stderr; with stdio: 'ignore' it can only
      // report the generic "Command failed: docker tag ..." string.
      expect(optionsFor('tag').stdio).toEqual(['ignore', 'ignore', 'pipe'])
      expect(optionsFor('rmi').stdio).toEqual(['ignore', 'ignore', 'pipe'])
    })

    it('still succeeds when untagging fails — an extra tag must not force a rebuild', () => {
      mockExecFileSync.mockImplementation((_cmd: unknown, args?: unknown) => {
        if ((args as string[])?.[0] === 'rmi') throw new Error('image is referenced')
        return Buffer.from('')
      })

      expect(pullRegistryImage('1.2.3')).toBe(true)
      expect(mockLogger.warn).toHaveBeenCalledWith('docker.registryTagRemoveFailed')
      expect(mockLogger.success).toHaveBeenCalledWith('docker.pullComplete')
    })
  })
})
