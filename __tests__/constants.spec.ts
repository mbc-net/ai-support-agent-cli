import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('constants', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
    delete process.env.AI_SUPPORT_AGENT_CONFIG_DIR
  })

  it('should export AGENT_VERSION from package.json', () => {
    const constants = require('../src/constants')
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'))
    expect(constants.AGENT_VERSION).toBe(pkg.version)
  })

  it('should return 0.0.0 when package.json cannot be read', () => {
    jest.doMock('fs', () => {
      return {
        ...jest.requireActual<typeof import('fs')>('fs'),
        readFileSync: () => {
          throw new Error('File not found')
        },
      }
    })

    const constants = require('../src/constants')
    expect(constants.AGENT_VERSION).toBe('0.0.0')
  })

  it('should return 0.0.0 when package.json has no version field', () => {
    jest.doMock('fs', () => {
      return {
        ...jest.requireActual<typeof import('fs')>('fs'),
        readFileSync: () => JSON.stringify({ name: 'test' }),
      }
    })

    const constants = require('../src/constants')
    expect(constants.AGENT_VERSION).toBe('0.0.0')
  })

  it('should expand ~ in AI_SUPPORT_AGENT_CONFIG_DIR to home directory', () => {
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = '~/my-config'
    const constants = require('../src/constants')
    const expected = path.resolve(os.homedir() + '/my-config')
    expect(constants.CONFIG_DIR).toBe(expected)
  })

  it('should resolve absolute path from AI_SUPPORT_AGENT_CONFIG_DIR without ~', () => {
    process.env.AI_SUPPORT_AGENT_CONFIG_DIR = '/tmp/agent-config'
    const constants = require('../src/constants')
    expect(constants.CONFIG_DIR).toBe('/tmp/agent-config')
  })

  it('should export NPM_COMMAND as npm.cmd on win32 and npm elsewhere', () => {
    // NPM_COMMAND is evaluated at module load time; verify it matches the expected value
    // for the current platform. The platform-specific selection is covered here so that
    // update-checker and version-manager don't each need a duplicate platform branch.
    const constants = require('../src/constants')
    const expected = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    expect(constants.NPM_COMMAND).toBe(expected)
  })

  it('should export all expected constant values', () => {
    const constants = require('../src/constants')

    expect(constants.CONFIG_DIR).toBe('.ai-support-agent')
    expect(constants.CONFIG_FILE).toBe('config.json')
    expect(constants.DEFAULT_POLL_INTERVAL).toBe(3000)
    expect(constants.DEFAULT_HEARTBEAT_INTERVAL).toBe(60000)
    expect(constants.AUTH_TIMEOUT).toBe(5 * 60 * 1000)
    expect(constants.MAX_OUTPUT_SIZE).toBe(10 * 1024 * 1024)
    expect(constants.MAX_AUTH_BODY_SIZE).toBe(64 * 1024)
    expect(constants.API_MAX_RETRIES).toBe(3)
    expect(constants.API_BASE_DELAY_MS).toBe(1000)
    expect(constants.API_REQUEST_TIMEOUT).toBe(10_000)
    expect(constants.CMD_DEFAULT_TIMEOUT).toBe(60_000)
    expect(constants.MAX_CMD_TIMEOUT).toBe(10 * 60 * 1000)
    expect(constants.MAX_FILE_READ_SIZE).toBe(10 * 1024 * 1024)
    expect(constants.PROCESS_LIST_TIMEOUT).toBe(10_000)

    // Localhost address
    expect(constants.LOCALHOST_ADDRESS).toBe('127.0.0.1')

    // Project code defaults
    expect(constants.PROJECT_CODE_DEFAULT).toBe('default')
    expect(constants.PROJECT_CODE_CLI_DIRECT).toBe('cli-direct')
    expect(constants.PROJECT_CODE_ENV_DEFAULT).toBe('env-default')

    // Anthropic API
    expect(constants.DEFAULT_ANTHROPIC_MODEL).toBe('claude-sonnet-4-6-20250514')
    expect(constants.ANTHROPIC_API_VERSION).toBe('2023-06-01')
    expect(constants.ANTHROPIC_API_URL).toBe('https://api.anthropic.com/v1/messages')
    expect(constants.DEFAULT_MAX_TOKENS).toBe(4096)

    // Docker log streaming constants
    expect(constants.DOCKER_MAX_SESSION_LOG_BYTES).toBe(2 * 1024 * 1024)
    expect(constants.DOCKER_MAX_LOG_CHUNK_BYTES).toBe(100_000)
    expect(constants.DOCKER_LOG_FLUSH_INTERVAL_MS).toBe(1_000)
    expect(constants.DOCKER_BUILD_ERROR_MAX_BYTES).toBe(3_000)

    // Docker marker filenames
    expect(constants.DOCKER_MARKER_BUILT_HASH).toBe('docker-built-hash')
    expect(constants.DOCKER_MARKER_REBUILD_NEEDED).toBe('docker-rebuild-needed')
    expect(constants.DOCKER_MARKER_CUSTOMIZATION_HASH).toBe('docker-customization-hash')
    expect(constants.DOCKER_MARKER_REGISTERED_AGENT_ID).toBe('docker-registered-agent-id')

    // Delayed restart
    expect(constants.DELAYED_RESTART_MS).toBe(1_000)

    // Chat executor
    expect(constants.CHAT_TIMEOUT).toBe(300_000)
    expect(constants.CHAT_SIGKILL_DELAY).toBe(5_000)
    expect(constants.CLAUDE_DETECT_TIMEOUT_MS).toBe(5_000)
    expect(constants.DEFAULT_APPSYNC_TIMEOUT_MS).toBe(300_000)

    // Log truncation
    expect(constants.LOG_MESSAGE_LIMIT).toBe(100)
    expect(constants.LOG_PAYLOAD_LIMIT).toBe(500)
    expect(constants.LOG_RESULT_LIMIT).toBe(300)
    expect(constants.LOG_DEBUG_LIMIT).toBe(200)
    expect(constants.CHUNK_LOG_LIMIT).toBe(100)

    // CLI flag constants
    expect(constants.CLI_FLAG_VERBOSE).toBe('--verbose')
    expect(constants.CLI_FLAG_NO_DOCKER).toBe('--no-docker')
    expect(constants.CLI_FLAG_NO_DOCKERFILE_SYNC).toBe('--no-dockerfile-sync')
    expect(constants.CLI_FLAG_NO_AUTO_UPDATE).toBe('--no-auto-update')

    // API endpoints
    expect(constants.API_ENDPOINTS.REGISTER('tenant1')).toBe('/api/tenant1/agent/register')
    expect(constants.API_ENDPOINTS.HEARTBEAT('tenant1')).toBe('/api/tenant1/agent/heartbeat')
    expect(constants.API_ENDPOINTS.COMMANDS_PENDING('tenant1')).toBe('/api/tenant1/agent/commands/pending')
    expect(constants.API_ENDPOINTS.COMMAND('tenant1', 'cmd-123')).toBe('/api/tenant1/agent/commands/cmd-123')
    expect(constants.API_ENDPOINTS.COMMAND_RESULT('tenant1', 'cmd-123')).toBe('/api/tenant1/agent/commands/cmd-123/result')
    expect(constants.API_ENDPOINTS.CONNECTION_STATUS('tenant1')).toBe('/api/tenant1/agent/connection-status')
    expect(constants.API_ENDPOINTS.VERSION).toBe('/api/agent/version')
    expect(constants.API_ENDPOINTS.FILES_UPLOAD_URL('tenant1', 'PROJ_01')).toBe('/api/tenant1/projects/PROJ_01/agent/files/upload-url')
    expect(constants.API_ENDPOINTS.FILES_DOWNLOAD_URL('tenant1', 'PROJ_01')).toBe('/api/tenant1/projects/PROJ_01/agent/files/download-url')
    expect(constants.API_ENDPOINTS.PROJECT_CONFIG('tenant1')).toBe('/api/tenant1/agent/project-config')
    expect(constants.API_ENDPOINTS.CONFIG('tenant1')).toBe('/api/tenant1/agent/config')
    expect(constants.API_ENDPOINTS.AWS_CREDENTIALS('tenant1')).toBe('/api/tenant1/agent/aws-credentials')
    expect(constants.API_ENDPOINTS.DB_CREDENTIALS('tenant1')).toBe('/api/tenant1/agent/db-credentials')
    expect(constants.API_ENDPOINTS.REPO_CREDENTIALS('tenant1', 'REPO_01')).toBe('/api/tenant1/agent/repo-credentials/REPO_01')
    expect(constants.API_ENDPOINTS.COMMAND_CHUNKS('tenant1', 'cmd-1')).toBe('/api/tenant1/agent/commands/cmd-1/chunks')
    expect(constants.API_ENDPOINTS.LOG_CHUNK('tenant1')).toBe('/api/tenant1/agent/logs/chunk')
    expect(constants.API_ENDPOINTS.LOG_SESSION('tenant1')).toBe('/api/tenant1/agent/logs/session')
    expect(constants.API_ENDPOINTS.SSH_CREDENTIALS('tenant1', 'host-1')).toBe('/api/tenant1/agent/ssh-credentials/host-1')
    expect(constants.API_ENDPOINTS.BROWSER_CREDENTIALS('tenant1')).toBe('/api/tenant1/agent/browser-credentials')
    expect(constants.API_ENDPOINTS.E2E_EXECUTION_STATUS('tenant1', 'PROJ_01', 'exec-1')).toBe('/api/tenant1/agent/e2e-test-executions/exec-1/status')
    expect(constants.API_ENDPOINTS.E2E_EXECUTION_STEPS('tenant1', 'PROJ_01', 'exec-1')).toBe('/api/tenant1/agent/e2e-test-executions/exec-1/steps')
    expect(constants.API_ENDPOINTS.E2E_EXECUTION_SCRIPT('tenant1', 'PROJ_01', 'exec-1')).toBe('/api/tenant1/agent/e2e-test-executions/exec-1/script')
    expect(constants.API_ENDPOINTS.ALERTS('tenant1', 'PROJ_01')).toBe('/api/tenant1/projects/PROJ_01/alerts')
    expect(constants.API_ENDPOINTS.ALERT('tenant1', 'PROJ_01', '42')).toBe('/api/tenant1/projects/PROJ_01/alerts/42')
    expect(constants.API_ENDPOINTS.ALERT_STATUS('tenant1', 'PROJ_01', '42')).toBe('/api/tenant1/projects/PROJ_01/alerts/42/status')
    expect(constants.API_ENDPOINTS.ALERT_CREATE_ISSUE('tenant1', 'PROJ_01', '42')).toBe('/api/tenant1/projects/PROJ_01/alerts/42/create-issue')
    expect(constants.API_ENDPOINTS.ISSUES('tenant1', 'PROJ_01')).toBe('/api/tenant1/projects/PROJ_01/issues')
  })
})
