import type { AgentChatMode, AgentChatModeOverrides } from './config'

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
    agentChatModeFallbackOrder?: AgentChatMode[]
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
    agentChatModeOverrides?: AgentChatModeOverrides
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
      isDefault?: boolean
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

/**
 * The only two `authType` values the agent CLI knows how to act on: whether
 * the overloaded `privateKey` field (see `SshExecCredential`) holds SSH key
 * material or a plaintext password.
 *
 * Single source of truth for the `authType !== 'password' && authType !==
 * 'privateKey'` check that was independently duplicated in
 * `commands/ssh-executor.ts` (`executeSshCommand`) and
 * `server-setup/server-setup-runner.ts` (`validateSshCredential`) — both
 * comments already noted they "mirror" each other. An unrecognized value
 * must never silently fall back to the key path (フォールバック禁止 —
 * see CLAUDE.md), which is exactly the bug this shared guard prevents from
 * drifting between the two call sites.
 */
export const SUPPORTED_SSH_AUTH_TYPES = ['password', 'privateKey'] as const

export type SshAuthType = (typeof SUPPORTED_SSH_AUTH_TYPES)[number]

export function isSupportedSshAuthType(authType: string): authType is SshAuthType {
  return (SUPPORTED_SSH_AUTH_TYPES as readonly string[]).includes(authType)
}

/**
 * SSH connection parameters returned by the `ssh_exec` JIT credential fetch
 * (see `ssh-credential-client.ts`). Extends the base `SshCredentials` shape
 * with the fields introduced by Tailscale support (admin-docs
 * `docs/specifications/ssh-tailscale-support.md`, section 3).
 *
 * The api-side `ssh_exec` credential endpoint is implemented in a later
 * phase (design doc: "api側の実装は別フェーズ(フェーズA/D)で拡張される"), so
 * every field beyond the base `SshCredentials` shape stays optional here —
 * this type must tolerate a response that does not yet include them.
 *
 * When `connectionType === 'tailscale'`, `tailnetHostname` (and optionally
 * `socksPort`, default 1055) identify the SOCKS5 route through the ECS
 * oneshot task's Tailscale sidecar; `hostname`/`port` are not used to reach
 * the target in that case (see ssh-executor.ts). `tailscaleAuthKey` is
 * carried through for forward-compatibility with the sidecar's `tailscale
 * up --authkey` bootstrap; the agent CLI's SSH executor never reads it
 * directly and must never log it.
 */
export interface SshExecCredential extends SshCredentials {
  connectionType?: 'ssh' | 'tailscale'
  tailnetHostname?: string
  socksPort?: number
  tailscaleAuthKey?: string
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

/**
 * プロジェクト共有の E2E サポートファイル（例: `lib/login.page.ts`）。
 * `path` は実行ディレクトリからの相対パスで、Playwright spec から相対 import される。
 */
export interface E2eSupportFile {
  path: string
  content: string
}

export interface E2eSupportFilesResponse {
  files: E2eSupportFile[]
}

/**
 * `ApiClient.reportE2eTestStep` に送信するペイロード。
 * AI 実行（`report_test_step` MCP ツール）と Playwright subprocess 実行
 * （`e2e-test-executor.ts`）の両方から使われるため、双方が送るフィールドの
 * 合併集合として全て任意項目にしている。
 */
export interface E2eTestStepPayload {
  testCaseId?: string
  stepNumber: number
  action: string
  selector?: string
  expected?: string
  actual?: string
  status: 'passed' | 'failed' | 'skipped'
  error?: string
  duration?: number
  /** ステップが実行された時刻（ISO文字列）。Playwright subprocess モードでは
   * テストの startTime + それ以前のstep累積durationから算出され、AI実行
   * モードでは `report_test_step` ツール呼び出し時刻がそのまま使われる。 */
  executedAt?: string
  /** Base64エンコードされたPNGスクリーンショット */
  screenshotBase64?: string
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
