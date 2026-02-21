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
}

export interface RegisterResponse {
  agentId: string
  appsyncUrl: string
  appsyncApiKey: string
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
