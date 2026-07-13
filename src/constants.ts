import * as os from 'os'
import { join, resolve } from 'path'

import { readJsonSync } from './utils'

function getPackageVersion(): string {
  try {
    const pkg = readJsonSync<{ version?: string }>(join(__dirname, '..', 'package.json'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// Environment variable name constants.
// Centralise the raw strings so a rename is a one-file change and typos are
// caught by TypeScript rather than silently producing undefined at runtime.
export const ENV_VARS = {
  TOKEN: 'AI_SUPPORT_AGENT_TOKEN',
  API_URL: 'AI_SUPPORT_AGENT_API_URL',
  TENANT_CODE: 'AI_SUPPORT_AGENT_TENANT_CODE',
  PROJECT_CODE: 'AI_SUPPORT_AGENT_PROJECT_CODE',
  CONFIG_DIR: 'AI_SUPPORT_AGENT_CONFIG_DIR',
  IN_DOCKER: 'AI_SUPPORT_AGENT_IN_DOCKER',
  ALLOW_HTTP: 'AI_SUPPORT_AGENT_ALLOW_HTTP',
  PROJECT_DIR_MAP: 'AI_SUPPORT_AGENT_PROJECT_DIR_MAP',
  TERMINAL_GRACE_MS: 'AI_SUPPORT_AGENT_TERMINAL_GRACE_MS',
  // 'true' force-enables the ecs_launch capability (skips AWS credential
  // detection), 'false' force-disables it. Unset = auto-detect.
  ECS_LAUNCHER: 'AI_SUPPORT_AGENT_ECS_LAUNCHER',
  CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_CODE_OAUTH_TOKEN',
  // Chat chunk batching (coalesce streaming delta chunks into fewer POSTs).
  // Unset = enabled. Set to 'false' to fall back to 1:1 immediate sending.
  CHAT_CHUNK_BATCH_ENABLED: 'AI_SUPPORT_AGENT_CHAT_CHUNK_BATCH_ENABLED',
  CHAT_CHUNK_BATCH_WINDOW_MS: 'AI_SUPPORT_AGENT_CHAT_CHUNK_BATCH_WINDOW_MS',
  CHAT_CHUNK_BATCH_MAX_BYTES: 'AI_SUPPORT_AGENT_CHAT_CHUNK_BATCH_MAX_BYTES',
} as const

export const CONFIG_DIR = (() => {
  const envDir = process.env[ENV_VARS.CONFIG_DIR]
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

// Chat chunk batching defaults.
// Streaming `delta` chunks are coalesced within a short time window (or until a
// byte threshold) so a single response produces far fewer HTTP POSTs.
export const CHAT_CHUNK_BATCH_WINDOW_MS = 80
export const CHAT_CHUNK_BATCH_MAX_BYTES = 8 * 1024 // 8 KB

// DB query connection timeout (MySQL connectTimeout / PostgreSQL connectionTimeoutMillis)
export const DB_CONNECT_TIMEOUT_MS = 10_000

// Command executor constants
export const CMD_DEFAULT_TIMEOUT = 60_000
export const MAX_CMD_TIMEOUT = 10 * 60 * 1000 // 10 minutes
export const MAX_FILE_READ_SIZE = 10 * 1024 * 1024 // 10 MB
export const MAX_FILE_WRITE_SIZE = 10 * 1024 * 1024 // 10 MB
export const PROCESS_LIST_TIMEOUT = 10_000
export const MAX_PROCESS_LIST_SIZE = 50_000 // 50 KB

// Interval bounds
export const MIN_INTERVAL = 1000
export const MAX_INTERVAL = 300_000 // 5 minutes

// Directory listing limit
export const MAX_DIR_ENTRIES = 1000

// Hidden entries to exclude from file listings
export const HIDDEN_ENTRIES = ['.claude', '.codex']

// Loopback address used when binding local HTTP servers and building local URLs
export const LOCALHOST_ADDRESS = '127.0.0.1'

// Default login URL (production). Must point at the app subdomain that actually hosts
// /agent-callback (web/) — the root domain serves the public marketing site
// (public-site/) and has no such route. Keep in sync with frontBaseUrl in
// api/infra/config/prod/index.ts.
export const DEFAULT_LOGIN_URL = 'https://app.ai-support-agent.com'

// Default API URL (production)
export const DEFAULT_API_URL = 'https://api.ai-support-agent.com'

// Default project codes
export const PROJECT_CODE_DEFAULT = 'default'
export const PROJECT_CODE_CLI_DIRECT = 'cli-direct'
export const PROJECT_CODE_ENV_DEFAULT = 'env-default'

// CloudWatch Alert stale-recovery constants.
// processing で止まったアラートの救済は通常ポーリングから分離し、低頻度で実行する。
// これにより processing アラートを毎回再処理して CQRS コマンドが無限増殖するのを防ぐ。
export const ALERT_STALE_RECOVERY_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
export const ALERT_STALE_PROCESSING_MINUTES = 30 // 30 分以上 processing を救済対象とする

// Auto-update constants
export const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour
export const UPDATE_CHECK_INITIAL_DELAY = 30_000 // 30 seconds
export const NPM_INSTALL_TIMEOUT = 120_000 // 2 minutes

// Platform-specific npm command (Windows uses npm.cmd, Unix/macOS uses npm)
export const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm'

// Anthropic API
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6-20250514'
// claude CLI 起動時のデフォルトモデル。未指定だと CLI デフォルト（Fable 5）に
// フォールバックして unavailable で落ちるため、常に明示指定する。
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6'
export const ANTHROPIC_API_VERSION = '2023-06-01'
export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
export const DEFAULT_MAX_TOKENS = 4096

// Chat executor
export const CHAT_TIMEOUT = 300_000
export const CHAT_TOOL_EXECUTION_TIMEOUT = 1_800_000
export const CHAT_SIGKILL_DELAY = 5_000
export const CLAUDE_DETECT_TIMEOUT_MS = 5_000
export const CODEX_DETECT_TIMEOUT_MS = 5_000
export const DEFAULT_APPSYNC_TIMEOUT_MS = 300_000
export const CHAT_RETRY_DELAY_MS = 3000
export const CHAT_MAX_ATTEMPTS = 2

// Log truncation
export const LOG_MESSAGE_LIMIT = 100
export const LOG_PAYLOAD_LIMIT = 500
export const LOG_RESULT_LIMIT = 300
export const LOG_DEBUG_LIMIT = 200
export const CHUNK_LOG_LIMIT = 100

// Browser proxy
/** BrowserProxySession の HTTP リクエストタイムアウト（60秒） */
export const BROWSER_PROXY_REQUEST_TIMEOUT_MS = 60_000

// read_conversation_file MCP tool: presigned S3 download timeouts
/** Text/image file download timeout (30 seconds) */
export const CONVERSATION_FILE_DOWNLOAD_TIMEOUT_MS = 30_000
/** Binary file (xlsx/pdf/docx/etc.) download timeout — larger files, longer budget (60 seconds) */
export const CONVERSATION_BINARY_DOWNLOAD_TIMEOUT_MS = 60_000

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
export const ERR_CODEX_CLI_NOT_FOUND = 'codex CLI が見つかりません。Codex CLI がインストールされていることを確認してください。'
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
  // JIT SSH credential lookup scoped to a single server_setup_exec command (see server-setup.md
  // "秘密鍵の受け渡し設計"). The target host is resolved server-side from the command's payload —
  // callers never pass a hostId directly, so a oneshot token cannot fetch an arbitrary host's key.
  SERVER_SETUP_SSH_CREDENTIAL: (tenantCode: string, commandId: string) =>
    `/api/${tenantCode}/agent/commands/${commandId}/server-setup-ssh-credential`,
  // JIT SSH credential lookup scoped to a single ssh_exec command (see
  // admin-docs docs/specifications/ssh-tailscale-support.md). Same
  // commandId-scoped design as SERVER_SETUP_SSH_CREDENTIAL: the target host
  // is resolved server-side from the command's payload, never from a
  // client-supplied hostId.
  SSH_EXEC_CREDENTIAL: (tenantCode: string, commandId: string) =>
    `/api/${tenantCode}/agent/commands/${commandId}/ssh-exec-credential`,
  BROWSER_CREDENTIALS: (tenantCode: string) => `/api/${tenantCode}/agent/browser-credentials`,
  E2E_ENV_VARIABLES: (tenantCode: string) => `/api/${tenantCode}/agent/e2e-env-variables`,
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
  ALERT_ACTIVE_ISSUE: (tenantCode: string, projectCode: string) =>
    `/api/${tenantCode}/projects/${projectCode}/alerts/active-issue`,
  ALERT_RESOLVE_ISSUE: (tenantCode: string, projectCode: string, alertNumber: string) =>
    `/api/${tenantCode}/projects/${projectCode}/alerts/${alertNumber}/resolve-issue`,
  ISSUES: (tenantCode: string, projectCode: string) =>
    `/api/${tenantCode}/projects/${projectCode}/issues`,
  // Agent tool 関連エンドポイント（タスク実行画面のエージェントが呼び出す）
  AGENT_TOOL_SEND_SLACK_MESSAGE: (tenantCode: string) =>
    `/api/${tenantCode}/agent/tools/send-slack-message`,
  AGENT_TOOL_SEND_SLACK_FILE: (tenantCode: string) =>
    `/api/${tenantCode}/agent/tools/send-slack-file`,
  AGENT_TOOL_TRIGGER_ALARM: (tenantCode: string) =>
    `/api/${tenantCode}/agent/tools/trigger-alarm`,
  AGENT_TOOL_READ_SLACK_THREAD: (tenantCode: string) =>
    `/api/${tenantCode}/agent/tools/read-slack-thread`,
  AGENT_TOOL_TRIGGER_E2E_TEST: (tenantCode: string) =>
    `/api/${tenantCode}/agent/tools/trigger-e2e-test`,
  // ドラフト→承認ワークフロー: システムのナレッジベースへ登録・改訂する（update_system_knowledge ツール）
  AGENT_KNOWLEDGE: (tenantCode: string) => `/api/${tenantCode}/agent/knowledge`,
  // ECS execution agent registration (ecs publish)
  ECS_AGENTS: (tenantCode: string) => `/api/${tenantCode}/agent/ecs-agents`,
} as const

// === ECS execution agent (launcher-agent architecture) ===
// Environment variables injected into the oneshot container at RunTask time.
export const ONESHOT_ENV_VARS = {
  AGENT_MODE: 'AGENT_MODE',
  COMMAND_ID: 'COMMAND_ID',
  AGENT_ID: 'AGENT_ID',
  TENANT_CODE: 'TENANT_CODE',
  PROJECT_CODE: 'PROJECT_CODE',
  API_BASE_URL: 'API_BASE_URL',
  AGENT_ONESHOT_TOKEN: 'AGENT_ONESHOT_TOKEN',
} as const

/** Value of AGENT_MODE that switches the CLI into oneshot (ECS container) mode */
export const AGENT_MODE_ONESHOT = 'oneshot'

/** Fixed container name used in the registered ECS task definition */
export const ECS_AGENT_CONTAINER_NAME = 'app'

/** Task definition family prefix: ai-support-ecs-agent-{tenantCode}-{agentId} */
export const ECS_TASK_FAMILY_PREFIX = 'ai-support-ecs-agent'

/** Default ECS task size (Fargate: 1 vCPU / 2 GB) */
export const DEFAULT_ECS_CPU = 1024
export const DEFAULT_ECS_MEMORY = 2048

/** Default awslogs log group for ECS execution agents */
export const DEFAULT_ECS_LOG_GROUP = '/ai-support-agent/ecs-agent'

/** ECS agent id prefix (agentId = `ecs-{uuid}`) */
export const ECS_AGENT_ID_PREFIX = 'ecs'

/**
 * Budget for resolving AWS credentials when deciding whether to advertise
 * the ecs_launch capability at registration time. Kept short so registration
 * is not delayed on hosts without any credential source (IMDS probing etc.).
 */
export const ECS_LAUNCHER_DETECT_TIMEOUT_MS = 3000

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

// SSH options shared by every place that shells out to `ssh` for git operations
// (GIT_SSH_COMMAND env value, generated SSH wrapper scripts). The agent manages
// its own per-repository key material, so known_hosts verification is skipped
// intentionally rather than left to the ambient environment.
export const SSH_NO_HOST_CHECK_FLAGS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null'

// Child process management
export const CHILD_PROCESS_MAX_RESTARTS = 5
export const CHILD_PROCESS_RESTART_DELAY_MS = 5000
export const CHILD_PROCESS_STOP_TIMEOUT_MS = 10000

// Token watcher
export const TOKEN_WATCH_INTERVAL_MS = 5000

// WebSocket reconnect
// Shared defaults reused by every reconnecting WebSocket client (AppSync, terminal,
// vscode tunnel) so the three per-feature constants files stay in lockstep instead of
// each restating the same literals.
// Infinity: the agent should never give up reconnecting from a transient network outage.
// Combine with WS_RECONNECT_MAX_DELAY_MS to cap the exponential backoff.
export const INFINITE_RECONNECT_RETRIES = Number.POSITIVE_INFINITY
export const DEFAULT_WS_RECONNECT_BASE_DELAY_MS = 1000

export const APPSYNC_MAX_RECONNECT_RETRIES = INFINITE_RECONNECT_RETRIES
export const APPSYNC_RECONNECT_BASE_DELAY_MS = DEFAULT_WS_RECONNECT_BASE_DELAY_MS
export const WS_RECONNECT_MAX_DELAY_MS = 60_000

// Close code the API gateway uses (api/src/agent/common/base-web.gateway.ts:
// WS_CLOSE_CODE_AUTH_REJECTED) when it closes a connection due to a permanent
// authentication rejection (invalid/expired token, or Agent ID token-binding
// mismatch) rather than a transient drop. Infinite reconnect retries above exist
// specifically for transient network outages; retrying with the SAME rejected
// credentials would just repeat the same rejection forever, so this code must be
// kept in sync with the server-side value.
export const WS_CLOSE_CODE_AUTH_REJECTED = 4001

// WebSocket heartbeat (ping/pong)
// Without an application-level ping, an idle WebSocket that is silently dropped by a
// load balancer (e.g. ALB idle timeout) never fires a 'close' event on the client, so
// the connection becomes a half-open "zombie" and the reconnect logic never runs.
//
// Dead-detection uses the ws-standard "isAlive" single-interval method (the same one
// used on the API gateway side): on each WS_HEARTBEAT_INTERVAL_MS tick, if no pong has
// been received since the previous tick the missed counter is incremented; once it
// reaches WS_PONG_MAX_MISSED consecutive misses the socket is terminated (which fires
// 'close' and triggers reconnect). A single missed pong therefore does NOT terminate,
// which removes the event-loop-stall false positive of the old per-ping setTimeout timer.
// The interval must be well below the ALB idle timeout (3600s in this deployment).
export const WS_HEARTBEAT_INTERVAL_MS = 30_000
// Number of consecutive missed pongs tolerated before the connection is considered dead.
export const WS_PONG_MAX_MISSED = 3

// Registration retry (persistent)
// register() failures used to leave the process in a silent zombie state.
// Retry forever with exponential backoff + jitter, capped at REGISTER_RETRY_MAX_DELAY_MS.
// 401/403 use a longer floor (REGISTER_AUTH_ERROR_DELAY_MS) to avoid hammering the server
// when the token is permanently invalid.
export const REGISTER_RETRY_BASE_DELAY_MS = 1_000
export const REGISTER_RETRY_MAX_DELAY_MS = 60_000
export const REGISTER_AUTH_ERROR_DELAY_MS = 5 * 60 * 1000

// Docker log streaming constants shared between DockerSupervisor and project-image-builder.
// MAX_SESSION_LOG_BYTES caps total in-memory log kept for S3 upload per session.
// MAX_LOG_CHUNK_BYTES must stay ≤ SubmitLogChunkDto.text @MaxLength (100,000 bytes).
// DOCKER_LOG_FLUSH_INTERVAL_MS controls how often buffered output is sent to the API.
// DOCKER_BUILD_ERROR_MAX_BYTES caps the build-error file written to the project config dir.
export const DOCKER_MAX_SESSION_LOG_BYTES = 2 * 1024 * 1024
export const DOCKER_MAX_LOG_CHUNK_BYTES = 100_000
export const DOCKER_LOG_FLUSH_INTERVAL_MS = 1_000
export const DOCKER_BUILD_ERROR_MAX_BYTES = 3_000

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

// CLI flag constants
export const CLI_FLAG_VERBOSE = '--verbose'
export const CLI_FLAG_NO_DOCKER = '--no-docker'
export const CLI_FLAG_NO_DOCKERFILE_SYNC = '--no-dockerfile-sync'
export const CLI_FLAG_NO_AUTO_UPDATE = '--no-auto-update'

// === Tailscale sidecar (SSH connectivity via a customer tailnet) ===
// See admin-docs docs/specifications/ssh-tailscale-support.md, section 2
// ("アーキテクチャ概要"). The sidecar is added to the oneshot ECS task
// definition only when `connectionType: 'tailscale'` support is enabled for
// that ECS execution agent; existing (non-Tailscale) task definitions are
// unaffected.
/** Container name of the Tailscale sidecar in the oneshot ECS task definition. */
export const TAILSCALE_SIDECAR_CONTAINER_NAME = 'tailscale'
/** Image the Tailscale sidecar container runs. */
export const TAILSCALE_SIDECAR_IMAGE = 'tailscale/tailscale'
/**
 * Default SOCKS5 port the sidecar's `tailscaled --tun=userspace-networking
 * --socks5-server=localhost:<port>` listens on. Overridable per SSH host via
 * `SshExecCredential.socksPort` (design doc section 3) to avoid collisions
 * when multiple tailnets are in play.
 */
export const TAILSCALE_SOCKS_PORT = 1055
/**
 * Env var name used to inject the Tailscale authkey into the sidecar
 * container via RunTask `containerOverrides` — never written to the task
 * definition itself (design doc section 4, "認証情報の非露出"). Must never be
 * logged.
 */
export const TAILSCALE_AUTHKEY_ENV_VAR = 'TS_AUTHKEY'
