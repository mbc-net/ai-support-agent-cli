import type { ChatPayload } from './chat'

export type AgentCommandType =
  | 'execute_command'
  | 'file_read'
  | 'file_write'
  | 'file_list'
  | 'file_rename'
  | 'file_delete'
  | 'file_mkdir'
  | 'process_list'
  | 'process_kill'
  | 'chat'
  | 'chat_cancel'
  | 'setup'
  | 'config_sync'
  | 'reboot'
  | 'update'

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

export function successResult(data: unknown): CommandResult {
  return { success: true, data }
}

export function errorResult(error: string, data?: unknown): CommandResult {
  return { success: false, error, ...(data !== undefined && { data }) }
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

export interface FileRenamePayload {
  oldPath?: unknown
  newPath?: unknown
}

export interface FileDeletePayload {
  path?: unknown
  recursive?: unknown
}

export interface FileMkdirPayload {
  path?: unknown
}

export interface ProcessKillPayload {
  pid?: unknown
  signal?: unknown
}

export interface ChatCancelPayload {
  targetCommandId?: unknown
}

// Discriminated union for type-safe command dispatch
export type CommandDispatch =
  | { type: 'execute_command'; payload: ShellCommandPayload }
  | { type: 'file_read'; payload: FileReadPayload }
  | { type: 'file_write'; payload: FileWritePayload }
  | { type: 'file_list'; payload: FileListPayload }
  | { type: 'file_rename'; payload: FileRenamePayload }
  | { type: 'file_delete'; payload: FileDeletePayload }
  | { type: 'file_mkdir'; payload: FileMkdirPayload }
  | { type: 'process_list'; payload: Record<string, never> }
  | { type: 'process_kill'; payload: ProcessKillPayload }
  | { type: 'chat'; payload: ChatPayload }
  | { type: 'chat_cancel'; payload: ChatCancelPayload }
  | { type: 'setup'; payload: Record<string, never> }
  | { type: 'config_sync'; payload: Record<string, never> }
  | { type: 'reboot'; payload: Record<string, never> }
  | { type: 'update'; payload: Record<string, never> }
