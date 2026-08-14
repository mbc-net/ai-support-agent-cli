import type { AgentChatMode, AgentChatModeOverrides } from './config'

/**
 * Admission request mode for multi-replica deployments.
 * - `initial`: first registration after process start. When the plan limit is
 *   already reached the server evicts the oldest replica so this one can run
 *   (a rolling update's new Pod replaces the old one).
 * - `standby`: a re-request from a replica that was evicted. The server admits
 *   it only when a slot is free, and never evicts on its behalf — otherwise
 *   evicted replicas would evict each other forever.
 */
export type AdmissionMode = 'initial' | 'standby'

export interface RegisterRequest {
  agentId: string
  hostname: string
  os: string
  arch: string
  ipAddress?: string
  capabilities?: string[]
  availableChatModes?: string[]
  activeChatMode?: string
  /** Replica identity. Omitted by single-replica deployments. */
  instanceId?: string
  admissionMode?: AdmissionMode
}

export type TransportMode = 'polling' | 'realtime'

/** Result of the replica admission check (only present when instanceId was sent). */
export interface AdmissionResult {
  accepted: boolean
  instanceId: string
  /** Applied limit; null means unlimited. */
  maxReplicas: number | null
  liveReplicas: number
  reason?: 'limit_reached'
  /** The replica evicted to make room for this one. */
  evictedInstanceId?: string
}

export interface RegisterResponse {
  agentId: string
  tenantCode: string
  projectCode?: string
  appsyncUrl: string
  appsyncApiKey: string
  transportMode: TransportMode
  wsEnabled?: boolean
  wsUrl?: string
  admission?: AdmissionResult
}

export interface SystemInfo {
  platform: string
  arch: string
  cpuUsage: number
  memoryUsage: number
  uptime: number
  /**
   * /tmp (または相当する temp dir) の使用率 (0-100)。取得失敗時は undefined。
   * agent 側で 85% を超えたら warning ログを出す。サーバ側でも閾値超過の通知に
   * 利用可能。
   */
  diskUsagePercent?: number
}

export interface HeartbeatResponse {
  success: true
  configHash?: string
  /**
   * Set when this replica no longer holds a slot (it was evicted to make room
   * for a newer replica). The agent must stop serving work and go back to
   * standby, re-requesting admission until a slot frees up.
   */
  evicted?: true
}

/**
 * チャットモード（ルーティング先）
 * - agent: 外部エージェント経由（デフォルト）
 * - builtin: サーバー内蔵エージェント
 */
export type ChatMode = 'agent' | 'builtin'

export interface AgentServerConfig {
  agentEnabled: boolean
  /**
   * 管理画面のプロジェクト設定で「自動アップデート」が有効か。
   *
   * 省略（旧サーバー）と false を区別しないこと。自動アップデートは opt-in であり、
   * 明示的な true 以外はすべて無効として扱う（auto-update-gate.ts を参照）。
   */
  autoUpdateEnabled?: boolean
  builtinAgentEnabled: boolean
  builtinFallbackEnabled: boolean
  externalAgentEnabled: boolean
  chatMode: ChatMode
  defaultAgentChatMode?: AgentChatMode
  agentChatModeFallbackOrder?: AgentChatMode[]
  agentChatModeOverrides?: AgentChatModeOverrides
  claudeCodeConfig?: {
    model?: string
    maxTokens?: number
    systemPrompt?: string
    allowedTools?: string[]
    addDirs?: string[]
  }
  codexConfig?: {
    model?: string
    systemPrompt?: string
    addDirs?: string[]
  }
}

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}
