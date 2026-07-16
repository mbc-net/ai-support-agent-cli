import type { ChatPayload } from './chat'
import type { EcsLaunchPayload, EcsStopPayload } from './ecs'
import type { ServerSetupExecPayload } from './server-setup'

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
  | 'e2e_test'
  | 'e2e_script_fix'
  | 'sync_repository'
  | 'ecs_launch'
  | 'ecs_stop'
  | 'server_setup_exec'
  | 'ssh_exec'

export type AgentCommandStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMEOUT'

export interface AgentCommand {
  commandId: string
  type: AgentCommandType
  /** APIが保存した依頼者ID。Slack Webhook起点では `slack:` プレフィックスを持つ。 */
  userId?: unknown
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

export interface E2eTestPayload {
  executionId?: unknown
  testCaseId?: unknown
  scenario?: unknown
  targetUrl?: unknown
  browserSettings?: unknown
  credentialId?: unknown
  executionMethod?: unknown
  playwrightScript?: unknown
  steps?: unknown
  recoveryMode?: unknown
  /** 選択された E2E 環境の ID。agent 側が API からプルして Playwright サブプロセスへ注入する */
  environmentId?: unknown
  agentChatMode?: unknown
}

export interface E2eScriptFixPayload {
  testCaseId?: unknown
  message?: unknown
  currentScript?: unknown
  agentChatMode?: unknown
}

export interface SyncRepositoryPayload {
  repositoryCode?: unknown
  branch?: unknown
}

/**
 * Payload of the `ssh_exec` command: a single ad-hoc SSH command run against
 * one SSH host (used by the chat `execute_ssh_command` tool's ECS oneshot
 * dispatch path — see admin-docs
 * `docs/specifications/ssh-tailscale-support.md`). The target host's
 * connection parameters (including Tailscale SOCKS5 fields, when
 * applicable) are resolved server-side and fetched JIT via
 * `ssh-credential-client.ts`; this payload only carries the command itself.
 */
export interface SshExecPayload {
  sshHostId?: unknown
  command?: unknown
  timeoutSeconds?: unknown
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
  | { type: 'e2e_test'; payload: E2eTestPayload }
  | { type: 'e2e_script_fix'; payload: E2eScriptFixPayload }
  | { type: 'sync_repository'; payload: SyncRepositoryPayload }
  | { type: 'ecs_launch'; payload: EcsLaunchPayload }
  | { type: 'ecs_stop'; payload: EcsStopPayload }
  | { type: 'server_setup_exec'; payload: ServerSetupExecPayload }
  | { type: 'ssh_exec'; payload: SshExecPayload }
