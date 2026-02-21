import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TEST_DIR_NAME = '.ai-support-agent-test-' + process.pid
const TEST_PARENT_DIR = os.tmpdir()
const TEST_CONFIG_DIR = path.join(TEST_PARENT_DIR, TEST_DIR_NAME)
const TEST_CONFIG_FILE = path.join(TEST_CONFIG_DIR, 'config.json')

// Mock constants module — only override CONFIG_DIR for test isolation
jest.mock('../src/constants', () => {
  const actual = jest.requireActual('../src/constants')
  return {
    ...actual,
    CONFIG_DIR: '.ai-support-agent-test-' + process.pid,
  }
})

// Mock os.homedir
jest.mock('os', () => {
  const originalOs = jest.requireActual('os')
  return {
    ...originalOs,
    homedir: () => require('os').tmpdir(),
  }
})

jest.mock('../src/logger')

import { loadConfig, saveConfig, clearConfig, getOrCreateAgentId, getProjectList, addProject, removeProject } from '../src/config-manager'

describe('config-manager', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true })
    }
  })

  describe('loadConfig', () => {
    it('should return null when config does not exist', () => {
      expect(loadConfig()).toBeNull()
    })

    it('should return null for invalid JSON config', () => {
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
      fs.writeFileSync(TEST_CONFIG_FILE, '{ invalid json !!!}')
      const config = loadConfig()
      expect(config).toBeNull()
    })

    it('should load existing config with projects', () => {
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
      fs.writeFileSync(
        TEST_CONFIG_FILE,
        JSON.stringify({
          agentId: 'test-agent',
          createdAt: '2026-01-01T00:00:00Z',
          projects: [
            { projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
          ],
        }),
      )

      const config = loadConfig()
      expect(config).not.toBeNull()
      expect(config?.projects).toHaveLength(1)
      expect(config?.projects?.[0].projectCode).toBe('proj-a')
    })
  })

  describe('saveConfig', () => {
    it('should create config directory and save config', () => {
      saveConfig({ projects: [{ projectCode: 'test', token: 'new-token', apiUrl: 'http://localhost:3030' }] })

      const config = loadConfig()
      expect(config?.projects).toHaveLength(1)
      expect(config?.projects?.[0].token).toBe('new-token')
      expect(config?.agentId).toBeDefined()
    })

    it('should merge with existing config', () => {
      saveConfig({ projects: [{ projectCode: 'p1', token: 'token1', apiUrl: 'http://localhost:3030' }] })
      saveConfig({ projects: [{ projectCode: 'p2', token: 'token2', apiUrl: 'http://localhost:3031' }] })

      const config = loadConfig()
      expect(config?.projects).toHaveLength(1)
      expect(config?.projects?.[0].projectCode).toBe('p2')
    })
  })

  describe('config directory permissions', () => {
    it('should enforce 0o700 on existing config directory', () => {
      // Create directory with permissive mode
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true, mode: 0o755 })
      const statBefore = fs.statSync(TEST_CONFIG_DIR)
      expect(statBefore.mode & 0o777).toBe(0o755)

      // saveConfig should enforce 0o700
      saveConfig({ projects: [{ projectCode: 'test', token: 'tok', apiUrl: 'http://test' }] })

      const statAfter = fs.statSync(TEST_CONFIG_DIR)
      expect(statAfter.mode & 0o777).toBe(0o700)
    })

    it('should create new config directory with 0o700', () => {
      expect(fs.existsSync(TEST_CONFIG_DIR)).toBe(false)

      saveConfig({ projects: [{ projectCode: 'test', token: 'tok', apiUrl: 'http://test' }] })

      const stat = fs.statSync(TEST_CONFIG_DIR)
      expect(stat.mode & 0o777).toBe(0o700)
    })
  })

  describe('getOrCreateAgentId', () => {
    it('should generate a new agent ID', () => {
      const agentId = getOrCreateAgentId()
      expect(agentId).toMatch(/^.+-[a-f0-9]{16}$/)
    })

    it('should return existing agent ID', () => {
      const first = getOrCreateAgentId()
      const second = getOrCreateAgentId()
      expect(second).toBe(first)
    })
  })

  describe('clearConfig', () => {
    it('should remove config file', () => {
      saveConfig({ projects: [{ projectCode: 'test', token: 'test', apiUrl: 'http://test' }] })
      expect(loadConfig()).not.toBeNull()

      clearConfig()
      expect(loadConfig()).toBeNull()
    })
  })

  describe('legacy config migration', () => {
    it('should migrate legacy single-token config to multi-project format', () => {
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
      fs.writeFileSync(
        TEST_CONFIG_FILE,
        JSON.stringify({
          agentId: 'legacy-agent',
          createdAt: '2026-01-01T00:00:00Z',
          token: 'legacy-token',
          apiUrl: 'http://legacy-api',
        }),
      )

      const config = loadConfig()
      expect(config).not.toBeNull()
      expect(config?.projects).toHaveLength(1)
      expect(config?.projects?.[0]).toEqual({
        projectCode: 'default',
        token: 'legacy-token',
        apiUrl: 'http://legacy-api',
      })

      // Verify the file on disk was updated (no more token/apiUrl at root)
      const raw = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf-8'))
      expect(raw.token).toBeUndefined()
      expect(raw.apiUrl).toBeUndefined()
      expect(raw.projects).toHaveLength(1)
    })

    it('should not migrate when projects already exist', () => {
      fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true })
      fs.writeFileSync(
        TEST_CONFIG_FILE,
        JSON.stringify({
          agentId: 'modern-agent',
          createdAt: '2026-01-01T00:00:00Z',
          projects: [
            { projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' },
          ],
        }),
      )

      const config = loadConfig()
      expect(config?.projects).toHaveLength(1)
      expect(config?.projects?.[0].projectCode).toBe('proj-a')
    })
  })

  describe('getProjectList', () => {
    it('should return projects array', () => {
      const projects = [
        { projectCode: 'p1', token: 't1', apiUrl: 'http://a1' },
        { projectCode: 'p2', token: 't2', apiUrl: 'http://a2' },
      ]
      const result = getProjectList({
        agentId: 'test',
        createdAt: '2026-01-01',
        projects,
      })
      expect(result).toEqual(projects)
    })

    it('should return empty array when no projects', () => {
      const result = getProjectList({
        agentId: 'test',
        createdAt: '2026-01-01',
      })
      expect(result).toEqual([])
    })
  })

  describe('addProject', () => {
    it('should add a new project', () => {
      saveConfig({})
      addProject({ projectCode: 'new-proj', token: 'new-token', apiUrl: 'http://new' })
      const config = loadConfig()
      expect(config?.projects).toHaveLength(1)
      expect(config?.projects?.[0].projectCode).toBe('new-proj')
    })

    it('should upsert existing project', () => {
      saveConfig({})
      addProject({ projectCode: 'proj', token: 'token1', apiUrl: 'http://api1' })
      addProject({ projectCode: 'proj', token: 'token2', apiUrl: 'http://api2' })
      const config = loadConfig()
      expect(config?.projects).toHaveLength(1)
      expect(config?.projects?.[0].token).toBe('token2')
    })
  })

  describe('removeProject', () => {
    it('should remove an existing project and return true', () => {
      saveConfig({})
      addProject({ projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' })
      addProject({ projectCode: 'proj-b', token: 'token-b', apiUrl: 'http://api-b' })

      const removed = removeProject('proj-a')
      expect(removed).toBe(true)

      const config = loadConfig()
      expect(config?.projects).toHaveLength(1)
      expect(config?.projects?.[0].projectCode).toBe('proj-b')
    })

    it('should return false when project does not exist', () => {
      saveConfig({})
      addProject({ projectCode: 'proj-a', token: 'token-a', apiUrl: 'http://api-a' })

      const removed = removeProject('nonexistent')
      expect(removed).toBe(false)

      const config = loadConfig()
      expect(config?.projects).toHaveLength(1)
    })

    it('should return false when no projects exist', () => {
      saveConfig({})

      const removed = removeProject('anything')
      expect(removed).toBe(false)
    })
  })
})
