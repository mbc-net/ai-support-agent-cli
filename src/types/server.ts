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
  /**
   * Process-lifetime nonce, distinct from `instanceId`: two processes can
   * legitimately report the same `instanceId` (e.g. a Kubernetes StatefulSet
   * Pod name is unique only within its own cluster, so the same token
   * deployed to two clusters produces the same Pod name in each). The server
   * uses the nonce to tell such processes apart and reject the second one
   * with `admission.reason === 'instance_id_conflict'` instead of treating
   * it as a reconnect of the first.
   */
  instanceNonce?: string
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
  /**
   * `limit_reached`: the plan's concurrent replica limit is already
   * satisfied by other replicas.
   * `instance_id_conflict`: another process is already live under this same
   * `instanceId` (distinguished by `instanceNonce`) — most commonly the same
   * token deployed to multiple Kubernetes clusters, whose Pod names collide
   * because a Pod name is unique only within its own cluster.
   */
  reason?: 'limit_reached' | 'instance_id_conflict'
  /** The replica evicted to make room for this one. */
  evictedInstanceId?: string
}

/**
 * Response of `POST .../agent/instances/self/release` (graceful shutdown drain,
 * phase 3). Sent once the agent has finished draining its in-flight commands so
 * the server can free the slot immediately instead of waiting for the
 * heartbeat-timeout reclaim.
 */
export interface ReleaseSelfResponse {
  released: boolean
  reason?: 'not_found' | 'nonce_mismatch' | 'already_released'
}

/**
 * `ApiClient.releaseSelf()` never throws — failures (including ones that never
 * reached the server) are represented as additional `reason` values not sent by
 * the server itself.
 */
export type ReleaseSelfResult =
  | ReleaseSelfResponse
  | { released: false; reason: 'no_replica_identity' | 'request_failed' }

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
