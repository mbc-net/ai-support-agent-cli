import { readFileSync } from 'fs'
import { join } from 'path'

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const CONFIG_DIR = '.ai-support-agent'
export const CONFIG_FILE = 'config.json'
export const DEFAULT_POLL_INTERVAL = 3000
export const DEFAULT_HEARTBEAT_INTERVAL = 30000
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

// Default project codes
export const PROJECT_CODE_DEFAULT = 'default'
export const PROJECT_CODE_CLI_DIRECT = 'cli-direct'
export const PROJECT_CODE_ENV_DEFAULT = 'env-default'

// Auto-update constants
export const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour
export const UPDATE_CHECK_INITIAL_DELAY = 30_000 // 30 seconds
export const NPM_INSTALL_TIMEOUT = 120_000 // 2 minutes

// API endpoint paths
export const API_ENDPOINTS = {
  REGISTER: '/api/agent/register',
  HEARTBEAT: '/api/agent/heartbeat',
  COMMANDS_PENDING: '/api/agent/commands/pending',
  COMMAND: (commandId: string) => `/api/agent/commands/${commandId}`,
  COMMAND_RESULT: (commandId: string) => `/api/agent/commands/${commandId}/result`,
  VERSION: '/api/agent/version',
} as const
