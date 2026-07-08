import type { AgentChatMode, AgentChatModeOverrides } from './config'

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
  tenantCode: string
  projectCode?: string
  appsyncUrl: string
  appsyncApiKey: string
  transportMode: TransportMode
  wsEnabled?: boolean
  wsUrl?: string
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
}

/**
 * チャットモード（ルーティング先）
 * - agent: 外部エージェント経由（デフォルト）
 * - builtin: サーバー内蔵エージェント
 */
export type ChatMode = 'agent' | 'builtin'

export interface AgentServerConfig {
  agentEnabled: boolean
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
