import type { AgentChatMode, ProjectRegistration } from './types'

/**
 * サーバーによる恒久的な認証拒否が起こりうる WebSocket トランスポートの種別。
 * 新しいトランスポートを追加する際はここに追記する（タイポを型で弾くため）。
 */
export type TransportKind = 'terminal' | 'vscode'

// ─── Parent → Child ─────────────────────────────────────────────

export interface IpcStartMessage {
  type: 'start'
  project: ProjectRegistration
  agentId: string
  options: {
    pollInterval: number
    heartbeatInterval: number
    agentChatMode?: AgentChatMode
    defaultProjectDir?: string
    verbose?: boolean
  }
}

export interface IpcShutdownMessage {
  type: 'shutdown'
}

export interface IpcUpdateMessage {
  type: 'update'
}

export interface IpcTokenUpdateMessage {
  type: 'token_update'
  token: string
}

export interface IpcBusyQueryMessage {
  type: 'busy_query'
}

export type ParentToChildMessage =
  | IpcStartMessage
  | IpcShutdownMessage
  | IpcUpdateMessage
  | IpcTokenUpdateMessage
  | IpcBusyQueryMessage

// ─── Child → Parent ─────────────────────────────────────────────

export interface IpcStartedMessage {
  type: 'started'
  tenantCode: string
  projectCode: string
}

export interface IpcErrorMessage {
  type: 'error'
  tenantCode: string
  projectCode: string
  message: string
}

export interface IpcStoppedMessage {
  type: 'stopped'
  tenantCode: string
  projectCode: string
}

export interface IpcBusyResponseMessage {
  type: 'busy_response'
  tenantCode: string
  projectCode: string
  busy: boolean
}

export interface IpcUpdateCompleteMessage {
  type: 'update_complete'
  tenantCode: string
  projectCode: string
}

/**
 * 子プロセス内の WebSocket 接続が、サーバーによる恒久的な認証拒否
 * （無効なトークン、Agent ID トークンバインディング不一致）で切断され、
 * 再接続を停止したことを親プロセスに通知する。子プロセス自体は他の
 * トランスポート（AppSync 等）のために生存し続けるため子プロセスの exit
 * では検知できず、この通知がないと親も監視基盤も気づけない。
 */
export interface IpcAuthRejectedMessage {
  type: 'auth_rejected'
  tenantCode: string
  projectCode: string
  /** 拒否されたトランスポート */
  transport: TransportKind
}

export type ChildToParentMessage =
  | IpcStartedMessage
  | IpcErrorMessage
  | IpcStoppedMessage
  | IpcBusyResponseMessage
  | IpcUpdateCompleteMessage
  | IpcAuthRejectedMessage

// ─── Type Guards ─────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isParentToChildMessage(msg: unknown): msg is ParentToChildMessage {
  if (!isObject(msg)) return false
  const { type } = msg
  if (type === 'shutdown' || type === 'update' || type === 'busy_query') return true
  if (type === 'token_update') {
    return typeof msg.token === 'string'
  }
  if (type === 'start') {
    return (
      isObject(msg.project) &&
      typeof msg.agentId === 'string' &&
      isObject(msg.options)
    )
  }
  return false
}

export function isChildToParentMessage(msg: unknown): msg is ChildToParentMessage {
  if (!isObject(msg)) return false
  const { type } = msg
  if (type === 'started' || type === 'stopped' || type === 'update_complete') {
    return typeof msg.tenantCode === 'string' && typeof msg.projectCode === 'string'
  }
  if (type === 'error') {
    return typeof msg.tenantCode === 'string' && typeof msg.projectCode === 'string' && typeof msg.message === 'string'
  }
  if (type === 'busy_response') {
    return typeof msg.tenantCode === 'string' && typeof msg.projectCode === 'string' && typeof msg.busy === 'boolean'
  }
  if (type === 'auth_rejected') {
    return (
      typeof msg.tenantCode === 'string' &&
      typeof msg.projectCode === 'string' &&
      (msg.transport === 'terminal' || msg.transport === 'vscode')
    )
  }
  return false
}
