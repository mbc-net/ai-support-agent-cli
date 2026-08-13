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
  /**
   * ECS execution agent ids published from this machine, keyed by ECR
   * repository URI. Used by `ecs publish` to reuse the same agentId on
   * re-publish (image update) instead of registering a new agent.
   */
  ecsAgents?: Record<string, string>
}

/**
 * エージェントチャットモード（エージェント内部の実行方式）
 * - claude_code: Claude Code CLI を使用
 * - codex: Codex CLI を使用
 * - api: Anthropic API 直接呼び出し
 */
export type AgentChatMode = 'claude_code' | 'codex' | 'api'
export type AgentChatModeSelection = AgentChatMode | 'auto'

export interface AgentChatModeOverrides {
  chat?: AgentChatMode
  task?: AgentChatMode
  e2eTest?: AgentChatMode
  e2eScriptFix?: AgentChatMode
}

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
  /**
   * Container image acquisition policy for the Docker mode base image.
   * 'auto' (default): pull the published image from the registry when nothing
   * is customised, build locally otherwise. 'never': always build locally.
   */
  dockerImagePull?: 'auto' | 'never'
}

/**
 * Legacy config format (pre-multi-project).
 * Used only during migration detection.
 */
export interface LegacyAgentConfig extends AgentConfig {
  token?: string
  apiUrl?: string
}
