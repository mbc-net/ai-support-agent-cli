import { readFileSync } from 'fs'
import * as os from 'os'
import { join, resolve } from 'path'

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const CONFIG_DIR = (() => {
  const envDir = process.env.AI_SUPPORT_AGENT_CONFIG_DIR
  if (!envDir) return '.ai-support-agent'
  const expanded = envDir.replace(/^~(?=$|\/)/, os.homedir())
  return resolve(expanded)
})()
export const CONFIG_FILE = 'config.json'
export const DEFAULT_POLL_INTERVAL = 3000
export const DEFAULT_HEARTBEAT_INTERVAL = 60000
export const AUTH_TIMEOUT = 5 * 60 * 1000 // 5 minutes
export const AGENT_VERSION = getPackageVersion()
export const MAX_OUTPUT_SIZE = 10 * 1024 * 1024 // 10 MB
export const MAX_AUTH_BODY_SIZE = 64 * 1024 // 64 KB

// API client constants
export const API_MAX_RETRIES = 3
export const API_BASE_DELAY_MS = 1000
export const API_REQUEST_TIMEOUT = 10_000

// Command executor constants
export const CMD_DEFAULT_TIMEOUT = 60_000
export const MAX_CMD_TIMEOUT = 10 * 60 * 1000 // 10 minutes
export const MAX_FILE_READ_SIZE = 10 * 1024 * 1024 // 10 MB
export const MAX_FILE_WRITE_SIZE = 10 * 1024 * 1024 // 10 MB
export const PROCESS_LIST_TIMEOUT = 10_000

// Interval bounds
export const MIN_INTERVAL = 1000
export const MAX_INTERVAL = 300_000 // 5 minutes

// Directory listing limit
export const MAX_DIR_ENTRIES = 1000

// Hidden entries to exclude from file listings
export const HIDDEN_ENTRIES = ['.claude']

// Default login URL (production)
export const DEFAULT_LOGIN_URL = 'https://ai-support-agent.com'

// Default API URL (production)
export const DEFAULT_API_URL = 'https://api.ai-support-agent.com'

// Default project codes
export const PROJECT_CODE_DEFAULT = 'default'
export const PROJECT_CODE_CLI_DIRECT = 'cli-direct'
export const PROJECT_CODE_ENV_DEFAULT = 'env-default'

// Auto-update constants
export const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour
export const UPDATE_CHECK_INITIAL_DELAY = 30_000 // 30 seconds
export const NPM_INSTALL_TIMEOUT = 120_000 // 2 minutes

// Anthropic API
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6-20250514'
export const ANTHROPIC_API_VERSION = '2023-06-01'
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
export const DEFAULT_MAX_TOKENS = 4096

// Chat executor
export const CHAT_TIMEOUT = 300_000
export const CHAT_SIGKILL_DELAY = 5_000
export const CLAUDE_DETECT_TIMEOUT_MS = 5_000
export const DEFAULT_APPSYNC_TIMEOUT_MS = 300_000

// Log truncation
export const LOG_MESSAGE_LIMIT = 100
export const LOG_PAYLOAD_LIMIT = 500
export const LOG_RESULT_LIMIT = 300
export const LOG_DEBUG_LIMIT = 200
export const CHUNK_LOG_LIMIT = 100

// Error messages
export const ERR_AGENT_ID_REQUIRED = 'agentId is required for chat command'
export const ERR_MESSAGE_REQUIRED = 'message is required'
export const ERR_NO_COMMAND_SPECIFIED = 'No command specified'
export const ERR_NO_CONTENT_SPECIFIED = 'No content specified'
export const ERR_NO_FILE_PATH_SPECIFIED = 'No file path specified'
export const ERR_INVALID_PID = 'Invalid PID: must be a positive integer'
export const ERR_ANTHROPIC_API_KEY_NOT_SET = 'ANTHROPIC_API_KEY is not set. API chat mode requires an Anthropic API key.'
export const ERR_AUTH_SERVER_START_FAILED = 'Failed to start auth server'
export const ERR_CLAUDE_CLI_NOT_FOUND = 'claude CLI が見つかりません。Claude Code がインストールされていることを確認してください。'
export const ERR_CHAT_REQUIRES_CLIENT = 'chat command requires commandId and client'
export const ERR_SETUP_REQUIRES_CALLBACK = 'setup command requires onSetup callback'
export const ERR_CONFIG_SYNC_REQUIRES_CALLBACK = 'config_sync command requires onConfigSync callback'
export const ERR_REBOOT_REQUIRES_CALLBACK = 'reboot command requires onReboot callback'
export const ERR_UPDATE_REQUIRES_CALLBACK = 'update command requires onUpdate callback'

// API endpoint paths
export const API_ENDPOINTS = {
  REGISTER: (tenantCode: string) => `/api/${tenantCode}/agent/register`,
  HEARTBEAT: (tenantCode: string) => `/api/${tenantCode}/agent/heartbeat`,
  COMMANDS_PENDING: (tenantCode: string) => `/api/${tenantCode}/agent/commands/pending`,
  COMMAND: (tenantCode: string, commandId: string) => `/api/${tenantCode}/agent/commands/${commandId}`,
  COMMAND_RESULT: (tenantCode: string, commandId: string) => `/api/${tenantCode}/agent/commands/${commandId}/result`,
  COMMAND_CHUNKS: (tenantCode: string, commandId: string) => `/api/${tenantCode}/agent/commands/${commandId}/chunks`,
  VERSION: '/api/agent/version',
  CONNECTION_STATUS: (tenantCode: string) => `/api/${tenantCode}/agent/connection-status`,
  CONFIG: (tenantCode: string) => `/api/${tenantCode}/agent/config`,
  AWS_CREDENTIALS: (tenantCode: string) => `/api/${tenantCode}/agent/aws-credentials`,
  DB_CREDENTIALS: (tenantCode: string) => `/api/${tenantCode}/agent/db-credentials`,
  REPO_CREDENTIALS: (tenantCode: string, repositoryId: string) => `/api/${tenantCode}/agent/repo-credentials/${repositoryId}`,
  PROJECT_CONFIG: (tenantCode: string) => `/api/${tenantCode}/agent/project-config`,
  FILES_UPLOAD_URL: (tenantCode: string, projectCode: string) => `/api/${tenantCode}/projects/${projectCode}/agent/files/upload-url`,
  FILES_DOWNLOAD_URL: (tenantCode: string, projectCode: string) => `/api/${tenantCode}/projects/${projectCode}/agent/files/download-url`,
} as const

export const CONFIG_SYNC_DEBOUNCE_MS = 2000
export const INITIAL_CONFIG_SYNC_MAX_RETRIES = 3
export const INITIAL_CONFIG_SYNC_RETRY_DELAY_MS = 2000

// SSE/Streaming constants
export const SSE_PREFIX = 'data: '
export const SSE_DONE = '[DONE]'
export const SSE_EVENT = {
  MESSAGE_START: 'message_start',
  MESSAGE_DELTA: 'message_delta',
  CONTENT_BLOCK_DELTA: 'content_block_delta',
  CONTENT_BLOCK_START: 'content_block_start',
} as const

export const ANTHROPIC_CONTENT_TYPE = {
  TEXT_DELTA: 'text_delta',
  TOOL_USE: 'tool_use',
} as const

// Git clone/pull
export const GIT_CLONE_TIMEOUT = 120_000
export const GIT_FETCH_TIMEOUT = 60_000
export const GIT_CHECKOUT_TIMEOUT = 30_000

// Child process management
export const CHILD_PROCESS_MAX_RESTARTS = 5
export const CHILD_PROCESS_RESTART_DELAY_MS = 5000
export const CHILD_PROCESS_STOP_TIMEOUT_MS = 10000

// Token watcher
export const TOKEN_WATCH_INTERVAL_MS = 5000

// WebSocket reconnect
export const APPSYNC_MAX_RECONNECT_RETRIES = 5
export const APPSYNC_RECONNECT_BASE_DELAY_MS = 1000
