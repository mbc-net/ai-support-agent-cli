import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

jest.mock('../src/logger')

describe('CONFIG_DIR with AI_SUPPORT_AGENT_CONFIG_DIR env', () => {
  const originalEnv = process.env.AI_SUPPORT_AGENT_CONFIG_DIR

  afterEach(() => {
    // Restore env
    if (originalEnv === undefined) {
      delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    } else {
      process.env.AI_SUPPORT_AGENT_CONFIG_DIR = originalEnv
    }
    // Clear module cache so constants.ts re-evaluates
    jest.resetModules()
  })

  it('should default to .ai-support-agent when env is not set', () => {
    delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    const { CONFIG_DIR } = require('../src/constants')
    expect(CONFIG_DIR).toBe('.ai-support-agent')
  })

  it('should use env value as absolute path', () => {
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = '/tmp/custom-config-dir'
    const { CONFIG_DIR } = require('../src/constants')
    expect(CONFIG_DIR).toBe('/tmp/custom-config-dir')
  })

  it('should expand ~ to home directory', () => {
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = '~/.ai-support-agent-dev'
    const { CONFIG_DIR } = require('../src/constants')
    expect(CONFIG_DIR).toBe(path.join(os.homedir(), '.ai-support-agent-dev'))
  })

  it('should not expand ~ in the middle of path', () => {
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = '/tmp/~/config'
    const { CONFIG_DIR } = require('../src/constants')
    expect(CONFIG_DIR).toBe('/tmp/~/config')
  })

  it('should expand lone ~', () => {
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = '~'
    const { CONFIG_DIR } = require('../src/constants')
    expect(CONFIG_DIR).toBe(os.homedir())
  })

  it('should resolve relative path with ./ to CWD-based absolute path', () => {
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = './ai-support-agent-beta'
    const { CONFIG_DIR } = require('../src/constants')
    expect(CONFIG_DIR).toBe(path.resolve('./ai-support-agent-beta'))
    expect(path.isAbsolute(CONFIG_DIR)).toBe(true)
  })

  it('should resolve relative path without ./ to CWD-based absolute path', () => {
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = 'my-config'
    const { CONFIG_DIR } = require('../src/constants')
    expect(CONFIG_DIR).toBe(path.resolve('my-config'))
    expect(path.isAbsolute(CONFIG_DIR)).toBe(true)
  })
})

describe('config-manager with absolute CONFIG_DIR', () => {
  const testDir = path.join(os.tmpdir(), '.ai-support-agent-env-test-' + process.pid)

  beforeEach(() => {
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = testDir
    jest.resetModules()
  })

  afterEach(() => {
    delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR
    jest.resetModules()
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true })
    }
  })

  it('should save and load config using absolute CONFIG_DIR', () => {
    const { saveConfig, loadConfig } = require('../src/config-manager')

    saveConfig({ projects: [{ projectCode: 'dev-proj', token: 'dev-token', apiUrl: 'http://localhost:3030' }] })

    const configPath = path.join(testDir, 'config.json')
    expect(fs.existsSync(configPath)).toBe(true)

    const config = loadConfig()
    expect(config?.projects).toHaveLength(1)
    expect(config?.projects?.[0].projectCode).toBe('dev-proj')
  })

  it('should not use homedir when CONFIG_DIR is absolute', () => {
    const { saveConfig } = require('../src/config-manager')

    saveConfig({ projects: [{ projectCode: 'test', token: 'tok', apiUrl: 'http://test' }] })

    // Config should be in testDir, not in homedir
    const configPath = path.join(testDir, 'config.json')
    expect(fs.existsSync(configPath)).toBe(true)

    const homeConfig = path.join(os.homedir(), testDir, 'config.json')
    expect(fs.existsSync(homeConfig)).toBe(false)
  })
})
