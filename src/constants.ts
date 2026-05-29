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

// Loopback address used when binding local HTTP servers and building local URLs
export const LOCALHOST_ADDRESS = '127.0.0.1'

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
export const CHAT_TOOL_EXECUTION_TIMEOUT = 1_800_000
export const CHAT_SIGKILL_DELAY = 5_000
export const CLAUDE_DETECT_TIMEOUT_MS = 5_000
export const DEFAULT_APPSYNC_TIMEOUT_MS = 300_000
export const CHAT_RETRY_DELAY_MS = 3000
export const CHAT_MAX_ATTEMPTS = 2

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
export const ERR_E2E_TEST_REQUIRES_CLIENT = 'e2e_test command requires commandId and client'
export const ERR_SETUP_REQUIRES_CALLBACK = 'setup command requires onSetup callback'
export const ERR_CONFIG_SYNC_REQUIRES_CALLBACK = 'config_sync command requires onConfigSync callback'
export const ERR_REBOOT_REQUIRES_CALLBACK = 'reboot command requires onReboot callback'
export const ERR_UPDATE_REQUIRES_CALLBACK = 'update command requires onUpdate callback'
export const ERR_SYNC_REPOSITORY_REQUIRES_CALLBACK = 'sync_repository command requires onSyncRepository callback'

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
  SSH_CREDENTIALS: (tenantCode: string, hostId: string) => `/api/${tenantCode}/agent/ssh-credentials/${hostId}`,
  BROWSER_CREDENTIALS: (tenantCode: string) => `/api/${tenantCode}/agent/browser-credentials`,
  FILES_UPLOAD_URL: (tenantCode: string, projectCode: string) => `/api/${tenantCode}/projects/${projectCode}/agent/files/upload-url`,
  FILES_DOWNLOAD_URL: (tenantCode: string, projectCode: string) => `/api/${tenantCode}/projects/${projectCode}/agent/files/download-url`,
  E2E_EXECUTION_STATUS: (tenantCode: string, _projectCode: string, executionId: string) =>
    `/api/${tenantCode}/agent/e2e-test-executions/${executionId}/status`,
  E2E_EXECUTION_STEPS: (tenantCode: string, _projectCode: string, executionId: string) =>
    `/api/${tenantCode}/agent/e2e-test-executions/${executionId}/steps`,
  E2E_EXECUTION_SCRIPT: (tenantCode: string, _projectCode: string, executionId: string) =>
    `/api/${tenantCode}/agent/e2e-test-executions/${executionId}/script`,
  LOG_CHUNK: (tenantCode: string) => `/api/${tenantCode}/agent/logs/chunk`,
  LOG_SESSION: (tenantCode: string) => `/api/${tenantCode}/agent/logs/session`,
  // Alert 関連エンドポイント
  ALERTS: (tenantCode: string, projectCode: string) =>
    `/api/${tenantCode}/projects/${projectCode}/alerts`,
  ALERT: (tenantCode: string, projectCode: string, alertNumber: string) =>
    `/api/${tenantCode}/projects/${projectCode}/alerts/${alertNumber}`,
  ALERT_STATUS: (tenantCode: string, projectCode: string, alertNumber: string) =>
    `/api/${tenantCode}/projects/${projectCode}/alerts/${alertNumber}/status`,
  ALERT_CREATE_ISSUE: (tenantCode: string, projectCode: string, alertNumber: string) =>
    `/api/${tenantCode}/projects/${projectCode}/alerts/${alertNumber}/create-issue`,
  ALERT_ACTIVE_ISSUE: (tenantCode: string, projectCode: string) =>
    `/api/${tenantCode}/projects/${projectCode}/alerts/active-issue`,
  ISSUES: (tenantCode: string, projectCode: string) =>
    `/api/${tenantCode}/projects/${projectCode}/issues`,
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
// Infinity: the agent should never give up reconnecting from a transient network outage.
// Combine with WS_RECONNECT_MAX_DELAY_MS to cap the exponential backoff.
export const APPSYNC_MAX_RECONNECT_RETRIES = Number.POSITIVE_INFINITY
export const APPSYNC_RECONNECT_BASE_DELAY_MS = 1000
export const WS_RECONNECT_MAX_DELAY_MS = 60_000

// Registration retry (persistent)
// register() failures used to leave the process in a silent zombie state.
// Retry forever with exponential backoff + jitter, capped at REGISTER_RETRY_MAX_DELAY_MS.
// 401/403 use a longer floor (REGISTER_AUTH_ERROR_DELAY_MS) to avoid hammering the server
// when the token is permanently invalid.
export const REGISTER_RETRY_BASE_DELAY_MS = 1_000
export const REGISTER_RETRY_MAX_DELAY_MS = 60_000
export const REGISTER_AUTH_ERROR_DELAY_MS = 5 * 60 * 1000

// Docker marker filenames written to the per-project config dir to coordinate
// image build state between the in-container agent and the host DockerSupervisor.
export const DOCKER_MARKER_BUILT_HASH = 'docker-built-hash'
export const DOCKER_MARKER_REBUILD_NEEDED = 'docker-rebuild-needed'
export const DOCKER_MARKER_CUSTOMIZATION_HASH = 'docker-customization-hash'
export const DOCKER_MARKER_REGISTERED_AGENT_ID = 'docker-registered-agent-id'

// Exit code used by the in-container agent to signal "update complete, rebuild image"
// Must be distinct from 0 (clean stop) and 1 (error) to avoid false restarts on SIGINT.
export const DOCKER_UPDATE_EXIT_CODE = 42

// Exit code used by the in-container agent to signal "restart this project's container only"
// Used when Docker customization changes or a reboot is requested for a single project.
export const DOCKER_RESTART_EXIT_CODE = 43

// Graceful update deferral
export const UPDATE_BUSY_WAIT_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes max wait for busy agents
export const UPDATE_BUSY_POLL_INTERVAL_MS = 3_000          // poll every 3 seconds
export const UPDATE_FORCED_BUSY_WAIT_TIMEOUT_MS = 30_000   // 30 seconds for forced updates
export const BUSY_QUERY_TIMEOUT_MS = 5_000                  // 5 seconds for IPC busy query

// Delayed restart (reboot / update / docker rebuild)
export const DELAYED_RESTART_MS = 1_000

// AppSync notification action names
export const NOTIFICATION_ACTION = {
  AGENT_COMMAND: 'agent-command',
  CONFIG_UPDATE: 'config-update',
  ALERT_CREATED: 'alert-created',
  AGENT_LOG: 'agent-log',
} as const
