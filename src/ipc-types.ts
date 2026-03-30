import type { AgentChatMode, ProjectRegistration } from './types'

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
  projectCode: string
}

export interface IpcErrorMessage {
  type: 'error'
  projectCode: string
  message: string
}

export interface IpcStoppedMessage {
  type: 'stopped'
  projectCode: string
}

export interface IpcBusyResponseMessage {
  type: 'busy_response'
  projectCode: string
  busy: boolean
}

export interface IpcUpdateCompleteMessage {
  type: 'update_complete'
  projectCode: string
}

export type ChildToParentMessage =
  | IpcStartedMessage
  | IpcErrorMessage
  | IpcStoppedMessage
  | IpcBusyResponseMessage
  | IpcUpdateCompleteMessage

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
    return typeof msg.projectCode === 'string'
  }
  if (type === 'error') {
    return typeof msg.projectCode === 'string' && typeof msg.message === 'string'
  }
  if (type === 'busy_response') {
    return typeof msg.projectCode === 'string' && typeof msg.busy === 'boolean'
  }
  return false
}
