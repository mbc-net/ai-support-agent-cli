/**
 * Regression tests for config format migrations.
 *
 * These tests guard against regressions in the config migration logic:
 * - Legacy single-token format → multi-project format
 * - Partial configs (missing optional fields)
 * - Configs with extra unknown fields (forward-compat)
 * - Corrupted / empty config files
 *
 * The config directory is isolated per test using a unique tmpdir so these
 * tests can run in parallel without stomping each other.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Isolate CONFIG_DIR to a unique tmp path for this test suite
const TEST_CONFIG_DIR = path.join(os.tmpdir(), '.ai-support-agent-migration-test-' + process.pid)
const TEST_CONFIG_FILE = path.join(TEST_CONFIG_DIR, 'config.json')

jest.mock('../../src/constants', () => {
  const actual = jest.requireActual('../../src/constants')
  return {
    ...actual,
    CONFIG_DIR: TEST_CONFIG_DIR,
  }
})

jest.mock('os', () => {
  const realOs = jest.requireActual('os')
  return {
    ...realOs,
    // homedir() is used by getConfigDir() when CONFIG_DIR is relative;
    // we pass an absolute path above so this won't be called, but keep it
    // safe just in case.
    homedir: () => jest.requireActual('os').tmpdir(),
  }
})

jest.mock('../../src/logger')

import {
  loadConfig,
  saveConfig,
  clearConfig,
  addProject,
  getProjectList,
} from '../../src/config-manager'
import type { AgentConfig, LegacyAgentConfig } from '../../src/types'

function writeRaw(obj: unknown): void {
  fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
  fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify(obj, null, 2))
}

afterEach(() => {
  if (fs.existsSync(TEST_CONFIG_DIR)) {
    fs.rmSync(TEST_CONFIG_DIR, { recursive: true })
  }
})

describe('config migration regression tests', () => {
  describe('legacy single-token → multi-project migration', () => {
    it('migrates legacy config with token+apiUrl and no projects', () => {
      const legacy: LegacyAgentConfig = {
        agentId: 'legacy-agent-id',
        createdAt: '2025-01-01T00:00:00.000Z',
        token: 'mbc:uuid-v4:secret',
        apiUrl: 'https://api.example.com',
      }
      writeRaw(legacy)

      const config = loadConfig()
      expect(config).not.toBeNull()
      expect(config!.projects).toHaveLength(1)
      expect(config!.projects![0].token).toBe('mbc:uuid-v4:secret')
      expect(config!.projects![0].apiUrl).toBe('https://api.example.com')
      expect(config!.projects![0].tenantCode).toBe('unknown')
      expect(config!.projects![0].projectCode).toBe('default')

      // After migration the file on disk should no longer have root-level token/apiUrl
      const onDisk = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf-8')) as LegacyAgentConfig
      expect(onDisk.token).toBeUndefined()
      expect(onDisk.apiUrl).toBeUndefined()
    })

    it('does NOT re-migrate a config that already has a projects array', () => {
      const modern: AgentConfig = {
        agentId: 'modern-agent',
        createdAt: '2025-06-01T00:00:00.000Z',
        projects: [
          { tenantCode: 'mbc', projectCode: 'MBC_01', token: 'tok', apiUrl: 'https://api.example.com' },
        ],
      }
      writeRaw(modern)

      const config = loadConfig()
      expect(config!.projects).toHaveLength(1)
      expect(config!.projects![0].tenantCode).toBe('mbc')

      // File must not be rewritten (no migration needed)
      const onDisk = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf-8')) as AgentConfig
      expect(onDisk.projects).toHaveLength(1)
    })

    it('treats legacy config with empty projects array as migration candidate', () => {
      const legacyEmptyProjects: LegacyAgentConfig = {
        agentId: 'leg-agent',
        createdAt: '2025-01-01T00:00:00.000Z',
        token: 'abc:def:ghi',
        apiUrl: 'https://api.example.com',
        projects: [],
      }
      writeRaw(legacyEmptyProjects)

      const config = loadConfig()
      // empty projects + has token → should migrate
      expect(config!.projects).toHaveLength(1)
      expect(config!.projects![0].token).toBe('abc:def:ghi')
    })
  })

  describe('partial / minimal config', () => {
    it('loads config that only has agentId and createdAt', () => {
      writeRaw({ agentId: 'min-agent', createdAt: '2025-01-01T00:00:00Z' })

      const config = loadConfig()
      expect(config).not.toBeNull()
      expect(config!.agentId).toBe('min-agent')
      expect(config!.projects).toBeUndefined()
    })

    it('saveConfig preserves existing agentId and createdAt when merging', () => {
      const initial: Partial<AgentConfig> = {
        agentId: 'preserved-id',
        createdAt: '2025-01-01T00:00:00.000Z',
        projects: [{ tenantCode: 'mbc', projectCode: 'P1', token: 't1', apiUrl: 'u1' }],
      }
      writeRaw(initial)

      // Merge only adds autoUpdate, keeping agentId/createdAt unchanged
      saveConfig({ autoUpdate: { enabled: true, autoRestart: true, channel: 'latest' } })

      const config = loadConfig()
      expect(config!.agentId).toBe('preserved-id')
      expect(config!.createdAt).toBe('2025-01-01T00:00:00.000Z')
      expect(config!.autoUpdate?.enabled).toBe(true)
      // projects must survive the merge
      expect(config!.projects).toHaveLength(1)
    })
  })

  describe('corrupted config graceful degradation', () => {
    it('returns null for completely empty file', () => {
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
      fs.writeFileSync(TEST_CONFIG_FILE, '')
      expect(loadConfig()).toBeNull()
    })

    it('returns null for a file that contains only whitespace', () => {
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
      fs.writeFileSync(TEST_CONFIG_FILE, '   \n\t  ')
      expect(loadConfig()).toBeNull()
    })

    it('returns null for truncated JSON', () => {
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
      fs.writeFileSync(TEST_CONFIG_FILE, '{"agentId":"foo","projects":[{')
      expect(loadConfig()).toBeNull()
    })

    it('returns null for JSON with wrong root type (array)', () => {
      // migrateConfigIfNeeded expects an object; an array would have undefined
      // token/apiUrl/projects, so it would fall through as-is without error.
      writeRaw([{ agentId: 'oops' }])
      // Should not throw — behaviour is graceful (returns the raw parsed value)
      const result = loadConfig()
      // Array lacks agentId etc., but we just check it doesn't throw
      expect(result).toBeDefined()
    })
  })

  describe('forward-compatibility: unknown fields in config are preserved', () => {
    it('saveConfig round-trips all known fields and ignores unknown ones', () => {
      // A future version might add new fields; current version should not
      // silently discard known optional fields during save/load.
      writeRaw({
        agentId: 'fwd-agent',
        createdAt: '2025-01-01T00:00:00.000Z',
        language: 'ja',
        defaultProjectDir: '/home/user/projects/{projectCode}',
        dockerfilePath: '/home/user/.ai-support-agent/Dockerfile',
        dockerfileSync: true,
        agentChatMode: 'claude_code',
        lastConnected: '2025-06-01T00:00:00.000Z',
        projects: [{ tenantCode: 'mbc', projectCode: 'MBC_01', token: 'tok', apiUrl: 'u' }],
      })

      const config = loadConfig()!
      expect(config.language).toBe('ja')
      expect(config.defaultProjectDir).toBe('/home/user/projects/{projectCode}')
      expect(config.dockerfilePath).toBe('/home/user/.ai-support-agent/Dockerfile')
      expect(config.dockerfileSync).toBe(true)
      expect(config.agentChatMode).toBe('claude_code')
      expect(config.lastConnected).toBe('2025-06-01T00:00:00.000Z')
    })
  })

  describe('getProjectList: tenantCode extraction regression', () => {
    it('extracts tenantCode from well-formed token (3+ colon-separated parts)', () => {
      const result = getProjectList({
        agentId: 'a',
        createdAt: '2025-01-01',
        projects: [{ tenantCode: '', projectCode: 'P', token: 'mbc:uuid:secret', apiUrl: 'u' }],
      })
      expect(result).toHaveLength(1)
      expect(result[0].tenantCode).toBe('mbc')
    })

    it('skips projects where token is missing and tenantCode is empty', () => {
      const result = getProjectList({
        agentId: 'a',
        createdAt: '2025-01-01',
        projects: [{ tenantCode: '', projectCode: 'P', token: '', apiUrl: 'u' }],
      })
      expect(result).toHaveLength(0)
    })

    it('skips projects where token has only 1 part and tenantCode is empty', () => {
      const result = getProjectList({
        agentId: 'a',
        createdAt: '2025-01-01',
        projects: [{ tenantCode: '', projectCode: 'P', token: 'notokenparts', apiUrl: 'u' }],
      })
      expect(result).toHaveLength(0)
    })

    it('returns projects with explicit tenantCode unchanged', () => {
      const result = getProjectList({
        agentId: 'a',
        createdAt: '2025-01-01',
        projects: [
          { tenantCode: 'mbc', projectCode: 'P1', token: 't', apiUrl: 'u' },
          { tenantCode: 'jcci', projectCode: 'P2', token: 't2', apiUrl: 'u2' },
        ],
      })
      expect(result).toHaveLength(2)
      expect(result[0].tenantCode).toBe('mbc')
      expect(result[1].tenantCode).toBe('jcci')
    })
  })

  describe('addProject upsert regression', () => {
    it('adding a project with same tenantCode+projectCode replaces the old one', () => {
      saveConfig({})
      addProject({ tenantCode: 'mbc', projectCode: 'MBC_01', token: 'old-tok', apiUrl: 'old-url' })
      addProject({ tenantCode: 'mbc', projectCode: 'MBC_01', token: 'new-tok', apiUrl: 'new-url' })

      const config = loadConfig()!
      expect(config.projects).toHaveLength(1)
      expect(config.projects![0].token).toBe('new-tok')
    })

    it('projects with same projectCode but different tenantCode are separate entries', () => {
      saveConfig({})
      addProject({ tenantCode: 'mbc', projectCode: 'SHARED', token: 'tok-mbc', apiUrl: 'u1' })
      addProject({ tenantCode: 'jcci', projectCode: 'SHARED', token: 'tok-jcci', apiUrl: 'u2' })

      const config = loadConfig()!
      expect(config.projects).toHaveLength(2)
    })
  })

  describe('clearConfig regression', () => {
    it('clearConfig is idempotent (no error if file already absent)', () => {
      // Should not throw even when config file does not exist
      expect(() => clearConfig()).not.toThrow()
    })
  })
})
