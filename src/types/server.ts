import type { AgentChatMode } from './config'

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
  claudeCodeConfig?: {
    model?: string
    maxTokens?: number
    systemPrompt?: string
    allowedTools?: string[]
    addDirs?: string[]
  }
}

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  region: string
}
