export interface ProjectConfigResponse {
  configHash: string
  project: {
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
    repositoryName: string
    repositoryUrl: string
    provider: string
    branch: string
    authMethod: string
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
}

export interface DbCredentials {
  name: string
  engine: string
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl?: boolean
  writePermissions?: { insert: boolean; update: boolean; delete: boolean }
}

export interface RepoCredentials {
  repositoryId: string
  repositoryUrl: string
  authMethod: string
  authSecret: string
}

export interface CachedProjectConfig {
  cachedAt: string
  configHash: string
  config: Omit<ProjectConfigResponse, 'aws' | 'backlog'> & {
    backlog?: {
      items: Array<{
        id: string
        domain: string
        projectKey: string
      }>
    }
  }
}
