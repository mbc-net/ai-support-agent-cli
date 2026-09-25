import type { RdpTunnelKind } from '../rdp/rdp-tunnel-message'
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
  /**
   * What this build of the agent can do at all: `'shell'`, `'chat'`,
   * `'terminal'`, … It is a property of the binary, sent once at registration.
   *
   * :::warning Not the same thing as {@link AgentCapabilityDeclaration}
   * The declarative capabilities added for `agentSettings.capabilities` (see
   * {@link AGENT_CAPABILITY_KEYS}) are the opposite direction: the *server*
   * tells the agent which optional features an administrator turned on, and the
   * agent answers with their **effective** state
   * ({@link AgentEffectiveCapability}) on every heartbeat. The two lists share
   * neither their values nor their direction of travel; only the word.
   * :::
   */
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

/**
 * Capability keys an administrator may declare from the admin UI
 * (`ProjectConfig.attributes.settings.agentSettings.capabilities`). Mirrors the
 * API's own allowlist (`api/src/agent/dto/agent-config.dto.ts`); adding a key
 * here without adding it there means it is never distributed, and vice versa.
 *
 * Only start-up options that are neither a bootstrap value, nor a secret, nor a
 * statement about the execution model belong here — see
 * `admin-docs/docs/features/agent-capabilities.md`.
 */
export const AGENT_CAPABILITY_KEYS = [
  /** Web RDP relaying. OR-composed with the `--rdp` start-up flag. */
  'rdp',
] as const

export type AgentCapabilityKey = (typeof AGENT_CAPABILITY_KEYS)[number]

/**
 * The server's declaration of which capabilities are turned on for this project.
 *
 * Each key is optional, and `undefined` means **not declared** — it is not the
 * same as an explicit `false`, exactly as with `autoUpdateEnabled`. Every
 * capability is opt-in: anything but an explicit `true` leaves the declaration
 * side off.
 *
 * See the warning on {@link RegisterRequest.capabilities}: that field is a
 * different concept that happens to share the name.
 */
export type AgentCapabilityDeclaration = { [K in AgentCapabilityKey]?: boolean }

/**
 * Which input turned a **reported** capability on.
 *
 * Deliberately has no `'none'` member: a capability that neither input enabled
 * is not reported at all (the key is simply absent from the array, which the
 * API renders as `inactive`). `'none'` exists only inside the resolver, as the
 * answer to "is this effective?" — see `CapabilitySource`.
 */
export type ReportedCapabilitySource = 'declared' | 'flag' | 'both'

/**
 * Effective state of one capability, as reported back on every heartbeat.
 *
 * `active` means the capability is actually usable right now. `not_applied`
 * means the declaration reached this agent but its runtime cannot honour it
 * without an operator action, named by {@link reason}.
 *
 * "Not reported at all" carries meaning too, and the two flavours differ:
 *
 * - the **field** absent from the heartbeat body — an agent too old to report,
 *   which the API renders as `unknown` and treats fail-closed;
 * - the field present but this **key** missing from the array — reported, and
 *   not enabled (`inactive`).
 *
 * An agent that understands capabilities therefore always sends the array, even
 * when it is empty; otherwise it is indistinguishable from an old one.
 */
export interface AgentEffectiveCapability {
  key: AgentCapabilityKey
  state: 'active' | 'not_applied'
  /**
   * What made this capability effective: the project declaration, the start-up
   * flag, or both.
   *
   * :::note optional である理由
   * 古い api はこのフィールドを知らない。DTO のホワイトリストで黙って除去される
   * だけで 400 にはならないため、送っても安全である。逆に新しい api は、報告して
   * こない旧エージェントのために欠落を許容する必要がある。
   * :::
   *
   * `not_applied` の項目にも載せる。「宣言したが適用できていない」のか「フラグで
   * 指定されたが適用できていない」のかで、利用者の次の一手（画面を戻す / 起動
   * オプションを外す）が変わるため。
   */
  source?: ReportedCapabilitySource
  /** Set only when `state === 'not_applied'`. */
  reason?:
    | 'action_required_redeploy'
    | 'action_required_restart'
    | 'apply_failed'
  /**
   * Hash of the **declaration alone** — never of the whole delivered config.
   * See `computeCapabilityDeclarationHash`.
   */
  declarationHash?: string
  /**
   * Short human-readable diagnostic. **Must not carry secrets**: it is stored
   * by the API and rendered in the admin UI.
   */
  detail?: string
  /**
   * RDP tunnel routes this agent can relay (api ⇔ agent contract 2). Only on
   * `key === 'rdp'` with `state === 'active'`, and only when a tunnel relay is
   * configured for this deployment form; otherwise **omitted**, which the API
   * treats like an agent that predates the feature (tunnel routes refused).
   * Values mirror the API's `RDP_TUNNEL_KINDS`.
   */
  rdpTunnels?: RdpTunnelKind[]
}

/** Max length the API accepts for {@link AgentEffectiveCapability.declarationHash}. */
export const AGENT_CAPABILITY_DECLARATION_HASH_MAX_LENGTH = 64
/** Max length the API accepts for {@link AgentEffectiveCapability.detail}. */
export const AGENT_CAPABILITY_DETAIL_MAX_LENGTH = 500

export interface AgentServerConfig {
  agentEnabled: boolean
  /**
   * 管理画面のプロジェクト設定で「自動アップデート」が有効か。
   *
   * 省略（旧サーバー）と false を区別しないこと。自動アップデートは opt-in であり、
   * 明示的な true 以外はすべて無効として扱う（auto-update-gate.ts を参照）。
   */
  autoUpdateEnabled?: boolean
  /**
   * Capabilities an administrator declared for this project.
   *
   * **Optional on purpose**: a server that predates the feature sends nothing,
   * and `undefined` must keep meaning "no declaration" rather than "everything
   * off" (see {@link AgentCapabilityDeclaration}).
   */
  capabilities?: AgentCapabilityDeclaration
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
