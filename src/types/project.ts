export interface ProjectConfigResponse {
  configHash: string
  project: {
    tenantCode?: string
    projectCode: string
    projectName: string
    description?: string
  }
  agent: {
    agentEnabled: boolean
    builtinAgentEnabled: boolean
    builtinFallbackEnabled: boolean
    externalAgentEnabled: boolean
    allowedTools: string[]
    claudeCodeConfig?: {
      additionalDirs?: string[]
      appendSystemPrompt?: string
      model?: string
    }
    codexConfig?: {
      additionalDirs?: string[]
      appendSystemPrompt?: string
      model?: string
    }
    gitPullStrategy?: 'merge' | 'rebase'
    dockerCustomization?: {
      aptPackages?: string[]
      npmPackages?: string[]
      commands?: string[]
      timezone?: string
    }
  }
  aws?: {
    accounts: Array<{
      id: string
      name: string
      description?: string
      profileName?: string
      region: string
      accountId: string
      auth: { method: 'access_key' } | { method: 'sso'; startUrl: string; ssoRegion: string; permissionSetName: string }
      isDefault: boolean
    }>
    cli?: {
      defaultProfile?: string
    }
  }
  databases?: Array<{
    name: string
    host: string
    port: number
    database: string
    engine: string
    writePermissions?: { insert: boolean; update: boolean; delete: boolean }
  }>
  repositories?: Array<{
    repositoryId: string
    repositoryCode: string
    repositoryName: string
    repositoryUrl: string
    provider: string
    branch: string
    authMethod: string
    description?: string
  }>
  documentation?: {
    sources: Array<{
      type: 'url' | 's3'
      url?: string
      bucket?: string
      prefix?: string
    }>
  }
  backlog?: {
    items: Array<{
      id: string
      domain: string
      apiKey: string
      projectKey: string
    }>
  }
  ssh?: {
    enabled: boolean
    hosts: Array<{
      hostId: string
      name: string
      hostname: string
      port?: number
      username: string
      authType: string
      description?: string
      environment?: string
    }>
  }
  browser?: {
    enabled: boolean
    credentials: Array<{
      credentialId: string
      name: string
      baseUrl: string
      environment?: string
      description?: string
    }>
  }
  cloudwatch?: CloudwatchConfig
  /**
   * Claude Code spawn 時に注入する環境変数オーバーレイ。
   *
   * 含まれるキーは process.env を上書きし、含まれないキーは agent ホストの
   * `process.env` がそのまま残る。値は復号済み（secret も平文）。
   */
  envVars?: Record<string, string>
}

export interface DbCredentials {
  name: string
  engine: string
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl?: { mode: string }
  writePermissions?: { insert: boolean; update: boolean; delete: boolean }
}

export interface RepoCredentials {
  repositoryId: string
  repositoryUrl: string
  authMethod: string
  authSecret: string
}

export interface SshCredentials {
  hostId: string
  hostname: string
  port: number
  username: string
  authType: string
  privateKey: string
}

export interface BrowserCredentials {
  credentialId: string
  baseUrl: string
  username: string
  password: string
  environment?: string
  description?: string
  promptText?: string
  customFields?: Record<string, string>
}

export interface E2eEnvironmentVariablesResponse {
  environmentId: string
  variables: Record<string, string>
}

export interface CloudwatchConfig {
  enabled: boolean
  /** サーバーが分 × 60000 に変換済みの ms 値 */
  pollingIntervalMs: number
  /** 読み取り専用。SNS サブスクリプション登録時に使用する URL */
  webhookUrl: string
}

export interface CachedProjectConfig {
  cachedAt: string
  configHash: string
  config: Omit<ProjectConfigResponse, 'aws' | 'backlog' | 'envVars'> & {
    backlog?: {
      items: Array<{
        id: string
        domain: string
        projectKey: string
      }>
    }
    // cloudwatch はセンシティブ情報を含まないためキャッシュ対象
    cloudwatch?: CloudwatchConfig
  }
}
