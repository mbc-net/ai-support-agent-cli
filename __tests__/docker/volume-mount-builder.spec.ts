/**
 * Tests for src/docker/volume-mount-builder.ts
 *
 * Covers buildProjectVolumeMounts branches not exercised by docker-runner.spec.ts,
 * specifically: project.token, project.apiUrl (with localhost replacement), and
 * the ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN passthrough.
 */

jest.mock('fs', () => ({
  existsSync: jest.fn(),
  realpathSync: jest.fn((p: string) => p),
  mkdirSync: jest.fn(),
  chmodSync: jest.fn(),
}))

jest.mock('../../src/config-manager', () => ({
  getConfigDir: jest.fn(() => '/mock/home/.ai-support-agent'),
  loadConfig: jest.fn(),
}))

jest.mock('../../src/i18n', () => ({
  t: jest.fn((key: string, params?: Record<string, string>) => {
    if (params) {
      return `${key} ${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ')}`
    }
    return key
  }),
}))

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../src/security', () => ({
  assertProjectCodeIsSafe: jest.fn(), // no-op by default
  BLOCKED_PATH_PREFIXES: [],
  getSensitiveHomePaths: jest.fn(() => []),
}))

import * as fs from 'fs'
import * as os from 'os'

import { buildProjectVolumeMounts, CONTAINER_HOME, CONTAINER_PROJECTS_BASE } from '../../src/docker/volume-mount-builder'
import type { ProjectRegistration } from '../../src/types'

const mockedFs = fs as jest.Mocked<typeof fs>
const mockAssertProjectCodeIsSafe = require('../../src/security').assertProjectCodeIsSafe as jest.Mock

function makeProject(overrides?: Partial<ProjectRegistration>): ProjectRegistration {
  return {
    tenantCode: 'test_tenant',
    projectCode: 'TEST_01',
    token: 'my-token-123',
    apiUrl: 'https://api.example.com',
    ...overrides,
  }
}

describe('buildProjectVolumeMounts', () => {
  const originalEnv = process.env
  const home = os.homedir()

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = { ...originalEnv }
    // Default: no .claude dir or .claude.json
    mockedFs.existsSync.mockReturnValue(false)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('should include standard env args for per-project container', () => {
    const project = makeProject()
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    expect(envArgs).toContain('AI_SUPPORT_AGENT_IN_DOCKER=1')
    expect(envArgs).toContain(`HOME=${CONTAINER_HOME}`)
    expect(envArgs).toContain(`AI_SUPPORT_AGENT_CONFIG_DIR=${CONTAINER_HOME}/.ai-support-agent`)
  })

  it('should include AI_SUPPORT_AGENT_TOKEN when project.token is set', () => {
    const project = makeProject({ token: 'secret-token-xyz' })
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    expect(envArgs).toContain('-e')
    expect(envArgs).toContain('AI_SUPPORT_AGENT_TOKEN=secret-token-xyz')
  })

  it('should NOT include AI_SUPPORT_AGENT_TOKEN when project.token is empty string', () => {
    const project = makeProject({ token: '' })
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    const tokenArgs = envArgs.filter((a) => a.startsWith('AI_SUPPORT_AGENT_TOKEN='))
    expect(tokenArgs).toHaveLength(0)
  })

  it('should include AI_SUPPORT_AGENT_API_URL when project.apiUrl is set', () => {
    const project = makeProject({ apiUrl: 'https://api.example.com' })
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    expect(envArgs).toContain('AI_SUPPORT_AGENT_API_URL=https://api.example.com')
  })

  it('should replace localhost with host.docker.internal in apiUrl', () => {
    const project = makeProject({ apiUrl: 'http://localhost:3000' })
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    expect(envArgs).toContain('AI_SUPPORT_AGENT_API_URL=http://host.docker.internal:3000')
  })

  it('should replace 127.0.0.1 with host.docker.internal in apiUrl', () => {
    const project = makeProject({ apiUrl: 'http://127.0.0.1:8080' })
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    expect(envArgs).toContain('AI_SUPPORT_AGENT_API_URL=http://host.docker.internal:8080')
  })

  it('should replace localhost without port in apiUrl', () => {
    const project = makeProject({ apiUrl: 'https://localhost' })
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    expect(envArgs).toContain('AI_SUPPORT_AGENT_API_URL=https://host.docker.internal')
  })

  it('should NOT replace localhost when it is a prefix of a longer hostname (boundary regression)', () => {
    // The old inline regex lacked a boundary check and would incorrectly
    // rewrite `http://localhost.example.com` → `http://host.docker.internal.example.com`.
    // toContainerApiUrl uses a lookahead so only bare localhost/127.0.0.1 match.
    const project = makeProject({ apiUrl: 'http://localhost.example.com:4030' })
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    expect(envArgs).toContain('AI_SUPPORT_AGENT_API_URL=http://localhost.example.com:4030')
  })

  it('should NOT include AI_SUPPORT_AGENT_API_URL when project.apiUrl is empty', () => {
    const project = makeProject({ apiUrl: '' })
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    const urlArgs = envArgs.filter((a) => a.startsWith('AI_SUPPORT_AGENT_API_URL='))
    expect(urlArgs).toHaveLength(0)
  })

  it('should include ANTHROPIC_API_KEY when set in environment', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN

    const project = makeProject()
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    expect(envArgs).toContain('ANTHROPIC_API_KEY=sk-ant-test-key')
  })

  it('should NOT include ANTHROPIC_API_KEY when not set in environment', () => {
    delete process.env.ANTHROPIC_API_KEY

    const project = makeProject()
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    const keyArgs = envArgs.filter((a) => a.startsWith('ANTHROPIC_API_KEY='))
    expect(keyArgs).toHaveLength(0)
  })

  it('should include CLAUDE_CODE_OAUTH_TOKEN when set in environment', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token-123'
    delete process.env.ANTHROPIC_API_KEY

    const project = makeProject()
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    expect(envArgs).toContain('CLAUDE_CODE_OAUTH_TOKEN=oauth-token-123')
  })

  it('should include TZ env var from host timezone', () => {
    const project = makeProject()
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    const tzArg = envArgs.find((a) => a.startsWith('TZ='))
    expect(tzArg).toBeDefined()
    // Should be a valid timezone string
    expect(tzArg!.length).toBeGreaterThan('TZ='.length)
  })

  it('should include AI_SUPPORT_AGENT_PROJECT_DIR_MAP env arg', () => {
    const project = makeProject({ projectCode: 'MY_PROJ' })
    const { envArgs } = buildProjectVolumeMounts(project, '/host/config/dir')

    const dirMapArg = envArgs.find((a) => a.startsWith('AI_SUPPORT_AGENT_PROJECT_DIR_MAP='))
    expect(dirMapArg).toBeDefined()
    expect(dirMapArg).toContain('MY_PROJ=')
    expect(dirMapArg).toContain(`${CONTAINER_PROJECTS_BASE}/MY_PROJ`)
  })

  it('should mount .claude dir when it exists on the host', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const strPath = p.toString()
      return strPath === `${home}/.claude`
    })

    const project = makeProject()
    const { mounts } = buildProjectVolumeMounts(project, '/host/config/dir')

    const claudeMount = mounts.find((m) => m.includes('/.claude:'))
    expect(claudeMount).toBeDefined()
    expect(claudeMount).toContain(`${home}/.claude:${CONTAINER_HOME}/.claude:rw`)
  })

  it('should mount .claude.json when it exists on the host', () => {
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      const strPath = p.toString()
      return strPath === `${home}/.claude.json`
    })

    const project = makeProject()
    const { mounts } = buildProjectVolumeMounts(project, '/host/config/dir')

    const claudeJsonMount = mounts.find((m) => m.includes('.claude.json:'))
    expect(claudeJsonMount).toBeDefined()
    expect(claudeJsonMount).toContain(`.claude.json:${CONTAINER_HOME}/.claude.json:rw`)
  })

  it('should mount projectConfigHostDir to container config dir', () => {
    const project = makeProject()
    const { mounts } = buildProjectVolumeMounts(project, '/host/my-config')

    const configMount = mounts.find((m) => m.includes('/host/my-config:'))
    expect(configMount).toBeDefined()
    expect(configMount).toBe(`/host/my-config:${CONTAINER_HOME}/.ai-support-agent:rw`)
  })

  it('should mount project.projectDir when it exists and is not blocked', () => {
    const projectDir = '/home/user/projects/my-project'
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      return p.toString() === projectDir
    })
    mockedFs.realpathSync.mockImplementation((p: string) => p)

    const project = makeProject({ projectCode: 'MY_PROJ', projectDir })
    const { mounts } = buildProjectVolumeMounts(project, '/host/config/dir')

    const projectMount = mounts.find((m) => m.includes(projectDir + ':'))
    expect(projectMount).toBeDefined()
    expect(projectMount).toBe(`${projectDir}:${CONTAINER_PROJECTS_BASE}/MY_PROJ:rw`)
  })

  it('should fall back to parent of projectConfigHostDir when projectDir is not set', () => {
    const project = makeProject({ projectDir: undefined })
    const { mounts } = buildProjectVolumeMounts(project, '/host/config/dir/tenant/TEST_01')

    // Parent of projectConfigHostDir
    const fallbackMount = mounts.find((m) => m.includes('/host/config/dir/tenant:'))
    expect(fallbackMount).toBeDefined()
    expect(fallbackMount).toContain(`${CONTAINER_PROJECTS_BASE}/TEST_01:rw`)
  })

  it('should call assertProjectCodeIsSafe for both projectCode and tenantCode', () => {
    const project = makeProject({ projectCode: 'MY_PROJ', tenantCode: 'my_tenant' })
    buildProjectVolumeMounts(project, '/host/config/dir')

    expect(mockAssertProjectCodeIsSafe).toHaveBeenCalledWith('MY_PROJ')
    expect(mockAssertProjectCodeIsSafe).toHaveBeenCalledWith('my_tenant')
  })

  it('should call mkdirSync for projectConfigHostDir', () => {
    const project = makeProject()
    buildProjectVolumeMounts(project, '/host/config/dir')

    expect(mockedFs.mkdirSync).toHaveBeenCalledWith('/host/config/dir', { recursive: true, mode: 0o700 })
  })

  it('should skip projectDir and use fallback when realpathSync throws', () => {
    const projectDir = '/home/user/projects/my-project'
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      return p.toString() === projectDir
    })
    mockedFs.realpathSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    const project = makeProject({ projectDir })
    // Should not throw
    const { mounts } = buildProjectVolumeMounts(project, '/host/config/dir/tenant/TEST_01')

    // No mount from projectDir since realpathSync failed
    const projectDirMount = mounts.find((m) => m.includes(projectDir + ':'))
    expect(projectDirMount).toBeUndefined()
  })
})
