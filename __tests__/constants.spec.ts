import * as fs from 'fs'
import * as path from 'path'

describe('constants', () => {
  afterEach(() => {
    jest.restoreAllMocks()
    jest.resetModules()
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

    // Project code defaults
    expect(constants.PROJECT_CODE_DEFAULT).toBe('default')
    expect(constants.PROJECT_CODE_CLI_DIRECT).toBe('cli-direct')
    expect(constants.PROJECT_CODE_ENV_DEFAULT).toBe('env-default')

    // Anthropic API
    expect(constants.DEFAULT_ANTHROPIC_MODEL).toBe('claude-sonnet-4-6-20250514')
    expect(constants.ANTHROPIC_API_VERSION).toBe('2023-06-01')
    expect(constants.ANTHROPIC_API_URL).toBe('https://api.anthropic.com/v1/messages')
    expect(constants.DEFAULT_MAX_TOKENS).toBe(4096)

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

    // API endpoints
    expect(constants.API_ENDPOINTS.REGISTER).toBe('/api/agent/register')
    expect(constants.API_ENDPOINTS.HEARTBEAT).toBe('/api/agent/heartbeat')
    expect(constants.API_ENDPOINTS.COMMANDS_PENDING).toBe('/api/agent/commands/pending')
    expect(constants.API_ENDPOINTS.COMMAND('cmd-123')).toBe('/api/agent/commands/cmd-123')
    expect(constants.API_ENDPOINTS.COMMAND_RESULT('cmd-123')).toBe('/api/agent/commands/cmd-123/result')
    expect(constants.API_ENDPOINTS.CONNECTION_STATUS).toBe('/api/agent/connection-status')
  })
})
