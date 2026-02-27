export type ReleaseChannel = 'latest' | 'beta' | 'alpha'

export interface VersionInfo {
  latestVersion: string
  minimumVersion: string
  channel: ReleaseChannel
  channels: Record<string, string>
}

export interface AutoUpdateConfig {
  enabled: boolean
  autoRestart: boolean
  channel: ReleaseChannel
}

export interface ProjectRegistration {
  projectCode: string
  token: string
  apiUrl: string
}

export interface AgentConfig {
  agentId: string
  createdAt: string
  lastConnected?: string
  language?: string
  projects?: ProjectRegistration[]
  autoUpdate?: AutoUpdateConfig
  agentChatMode?: AgentChatMode
}

/**
 * Legacy config format (pre-multi-project).
 * Used only during migration detection.
 */
export interface LegacyAgentConfig extends AgentConfig {
  token?: string
  apiUrl?: string
}

export type AgentCommandType =
  | 'execute_command'
  | 'file_read'
  | 'file_write'
  | 'file_list'
  | 'process_list'
  | 'process_kill'
  | 'chat'

export type AgentCommandStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMEOUT'

export interface AgentCommand {
  commandId: string
  type: AgentCommandType
  payload: Record<string, unknown>
  status: AgentCommandStatus
  createdAt: number
}

export interface PendingCommand {
  commandId: string
  type: AgentCommandType
  createdAt: number
}

export type CommandResult =
  | { success: true; data: unknown }
  | { success: false; error: string; data?: unknown }

export interface RegisterRequest {
  agentId: string
  hostname: string
  os: string
  arch: string
  ipAddress?: string
  capabilities?: string[]
  availableChatModes?: string[]
  activeChatMode?: string
}

export type TransportMode = 'polling' | 'realtime'

export interface RegisterResponse {
  agentId: string
  appsyncUrl: string
  appsyncApiKey: string
  transportMode: TransportMode
}

export interface SystemInfo {
  platform: string
  arch: string
  cpuUsage: number
  memoryUsage: number
  uptime: number
}

// Command payload types (compile-time hints for expected fields)
// Values are `unknown` because payloads come from external API;
// runtime validation via parseString/parseNumber is still required.

export interface ShellCommandPayload {
  command?: unknown
  timeout?: unknown
  cwd?: unknown
}

export interface FileReadPayload {
  path?: unknown
}

export interface FileWritePayload {
  path?: unknown
  content?: unknown
  createDirectories?: unknown
}

export interface FileListPayload {
  path?: unknown
}

export interface ProcessKillPayload {
  pid?: unknown
  signal?: unknown
}

export interface ChatPayload {
  message?: unknown
  conversationId?: unknown
  projectCode?: unknown
  history?: unknown
  locale?: unknown
}

/**
 * チャットモード（ルーティング先）
 * - agent: 外部エージェント経由（デフォルト）
 * - builtin: サーバー内蔵エージェント
 */
export type ChatMode = 'agent' | 'builtin'

/**
 * エージェントチャットモード（エージェント内部の実行方式）
 * - claude_code: Claude Code CLI を使用
 * - api: Anthropic API 直接呼び出し
 */
export type AgentChatMode = 'claude_code' | 'api'

export interface AgentServerConfig {
  agentEnabled: boolean
  builtinAgentEnabled: boolean
  builtinFallbackEnabled: boolean
  externalAgentEnabled: boolean
  chatMode: ChatMode
  defaultAgentChatMode?: AgentChatMode
  claudeCodeConfig?: {
    model?: string
    maxTokens?: number
    systemPrompt?: string
    allowedTools?: string[]
    addDirs?: string[]
  }
}

export type ChatChunkType =
  | 'delta'
  | 'tool_call'
  | 'tool_result'
  | 'done'
  | 'error'

export interface ChatChunk {
  index: number
  type: ChatChunkType
  content: string
}

// Discriminated union for type-safe command dispatch
export type CommandDispatch =
  | { type: 'execute_command'; payload: ShellCommandPayload }
  | { type: 'file_read'; payload: FileReadPayload }
  | { type: 'file_write'; payload: FileWritePayload }
  | { type: 'file_list'; payload: FileListPayload }
  | { type: 'process_list'; payload: Record<string, never> }
  | { type: 'process_kill'; payload: ProcessKillPayload }
  | { type: 'chat'; payload: ChatPayload }
