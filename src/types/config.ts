export type ReleaseChannel = 'latest' | 'beta' | 'alpha'

export type InstallMethod = 'global' | 'npx' | 'local' | 'dev'

export interface VersionInfo {
  latestVersion: string
  minimumVersion: string
  channel: ReleaseChannel
  channels: Record<string, string>
}

export interface AutoUpdateConfig {
  enabled: boolean
  autoRestart: boolean
  channel: ReleaseChannel
}

export interface ProjectRegistration {
  tenantCode: string
  projectCode: string
  token: string
  apiUrl: string
  projectDir?: string
}

/**
 * エージェントチャットモード（エージェント内部の実行方式）
 * - claude_code: Claude Code CLI を使用
 * - api: Anthropic API 直接呼び出し
 */
export type AgentChatMode = 'claude_code' | 'api'

export interface AgentConfig {
  agentId: string
  createdAt: string
  lastConnected?: string
  language?: string
  projects?: ProjectRegistration[]
  autoUpdate?: AutoUpdateConfig
  agentChatMode?: AgentChatMode
  defaultProjectDir?: string
  dockerfilePath?: string
  dockerfileSync?: boolean
}

/**
 * Legacy config format (pre-multi-project).
 * Used only during migration detection.
 */
export interface LegacyAgentConfig extends AgentConfig {
  token?: string
  apiUrl?: string
}
