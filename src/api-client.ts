import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'

import { AGENT_VERSION, API_BASE_DELAY_MS, API_ENDPOINTS, API_MAX_RETRIES, API_REQUEST_TIMEOUT, DEFAULT_API_URL, ENV_VARS } from './constants'
import { logger } from './logger'
import { RetryStrategy } from './retry-strategy'
import { toErrorMessage } from './utils'
import { extractTenantCodeFromToken } from './utils/token-utils'
import type {
  AgentCommand,
  AgentServerConfig,
  AwsCredentials,
  BrowserCredentials,
  ChatChunk,
  CommandResult,
  DbCredentials,
  E2eEnvironmentVariablesResponse,
  EcsAgentRegistration,
  HeartbeatResponse,
  PendingAlert,
  PendingCommand,
  ProjectConfigResponse,
  ReadSlackThreadResult,
  ReleaseChannel,
  RegisterRequest,
  RegisterResponse,
  RepoCredentials,
  SendSlackFileResult,
  SendSlackMessageResult,
  ServerSetupVariablesResponse,
  SshCredentials,
  SshExecCredential,
  SystemInfo,
  TriggerAlarmResult,
  TriggerE2eTestResult,
  UpdateSystemKnowledgeRequest,
  UpdateSystemKnowledgeResult,
  VersionInfo,
} from './types'


export class ApiClient {
  private readonly client: AxiosInstance
  private readonly retry: RetryStrategy
  private tenantCode = ''
  private projectCode = ''

  constructor(apiUrl: string, token: string) {
    const parsed = new URL(apiUrl)
    if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== 'host.docker.internal') {
      if (process.env[ENV_VARS.ALLOW_HTTP] === 'true') {
        logger.warn('API URL uses HTTP (not HTTPS). Token may be transmitted in plain text.')
      } else {
        throw new Error(
          `API URL uses HTTP (not HTTPS). Set ${ENV_VARS.ALLOW_HTTP}=true to allow insecure connections.`,
        )
      }
    }

    this.tenantCode = extractTenantCodeFromToken(token)

    this.client = axios.create({
      baseURL: apiUrl,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: API_REQUEST_TIMEOUT,
    })

    this.retry = new RetryStrategy({
      maxRetries: API_MAX_RETRIES,
      baseDelayMs: API_BASE_DELAY_MS,
    })
  }

  setTenantCode(code: string): void {
    this.tenantCode = code
  }

  /**
   * Read-only accessor for the tenant code derived from the current token
   * (or overridden via `setTenantCode`). Used by `server-setup-runner.ts` to
   * namespace the persistent per-host known_hosts file so distinct tenants
   * never share (or overwrite) each other's recorded SSH host keys.
   */
  getTenantCode(): string {
    return this.tenantCode
  }

  setProjectCode(code: string): void {
    this.projectCode = code
  }

  updateToken(newToken: string): void {
    this.client.defaults.headers['Authorization'] = `Bearer ${newToken}`
    this.tenantCode = extractTenantCodeFromToken(newToken)
  }

  private async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    return this.retry.withRetry(async () => {
      const { data } = await this.client.get<T>(url, config)
      return data
    })
  }

  private async post<T>(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<T> {
    return this.retry.withRetry(async () => {
      const { data } = await this.client.post<T>(url, body, config)
      return data
    })
  }

  private async postVoid(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<void> {
    await this.retry.withRetry(async () => {
      await this.client.post(url, body, config)
    })
  }

  private async putVoid(url: string, body?: unknown, config?: AxiosRequestConfig): Promise<void> {
    await this.retry.withRetry(async () => {
      await this.client.put(url, body, config)
    })
  }

  async register(request: RegisterRequest): Promise<RegisterResponse> {
    logger.debug(`Registering agent: ${request.agentId}`)
    const { ipAddress, availableChatModes, activeChatMode, ...rest } = request
    return this.post<RegisterResponse>(API_ENDPOINTS.REGISTER(this.tenantCode), {
      ...rest,
      version: AGENT_VERSION,
      ...(ipAddress && { ipAddress }),
      ...(availableChatModes !== undefined && { availableChatModes }),
      ...(activeChatMode !== undefined && { activeChatMode }),
    })
  }

  async heartbeat(
    agentId: string,
    systemInfo: SystemInfo,
    updateError?: string,
    availableChatModes?: string[],
    activeChatMode?: string,
    ipAddress?: string,
    configHash?: string,
    dockerBuildError?: string,
    authRejectedTransports?: string[],
  ): Promise<HeartbeatResponse | void> {
    logger.debug('Sending heartbeat')
    return this.post<HeartbeatResponse>(API_ENDPOINTS.HEARTBEAT(this.tenantCode), {
      agentId,
      timestamp: Date.now(),
      version: AGENT_VERSION,
      systemInfo,
      ...(updateError && { updateError }),
      ...(availableChatModes !== undefined && { availableChatModes }),
      ...(activeChatMode !== undefined && { activeChatMode }),
      ...(ipAddress && { ipAddress }),
      ...(configHash && { configHash }),
      ...(dockerBuildError !== undefined && { dockerBuildError }),
      ...(authRejectedTransports !== undefined && { authRejectedTransports }),
    })
  }

  async getVersionInfo(channel: ReleaseChannel = 'latest'): Promise<VersionInfo> {
    // Version info is global (not per-environment), always fetch from production API
    const { data } = await axios.get<VersionInfo>(`${DEFAULT_API_URL}${API_ENDPOINTS.VERSION}`, {
      params: { channel },
      timeout: API_REQUEST_TIMEOUT,
    })
    return data
  }

  async getPendingCommands(agentId: string): Promise<PendingCommand[]> {
    logger.debug('Polling for pending commands')
    return this.get<PendingCommand[]>(API_ENDPOINTS.COMMANDS_PENDING(this.tenantCode), { params: { agentId } })
  }

  private validateCommandId(commandId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(commandId)) {
      throw new Error(`Invalid command ID format: ${commandId}`)
    }
  }

  async getCommand(commandId: string, agentId: string): Promise<AgentCommand> {
    this.validateCommandId(commandId)
    logger.debug(`Fetching command: ${commandId}`)
    return this.get<AgentCommand>(API_ENDPOINTS.COMMAND(this.tenantCode, commandId), { params: { agentId } })
  }

  async submitResult(
    commandId: string,
    result: CommandResult,
    agentId: string,
  ): Promise<void> {
    this.validateCommandId(commandId)
    logger.debug(`Submitting result for command: ${commandId}`)
    await this.postVoid(API_ENDPOINTS.COMMAND_RESULT(this.tenantCode, commandId), result, { params: { agentId } })
  }

  async reportConnectionStatus(
    agentId: string,
    status: 'connected' | 'disconnected',
  ): Promise<void> {
    await this.postVoid(API_ENDPOINTS.CONNECTION_STATUS(this.tenantCode), {
      agentId,
      status,
      timestamp: Date.now(),
    })
  }

  async getConfig(): Promise<AgentServerConfig> {
    logger.debug('Fetching agent config from server')
    return this.get<AgentServerConfig>(API_ENDPOINTS.CONFIG(this.tenantCode))
  }

  async getProjectConfig(): Promise<ProjectConfigResponse> {
    logger.debug('Fetching project config from server')
    return this.get<ProjectConfigResponse>(API_ENDPOINTS.PROJECT_CONFIG(this.tenantCode))
  }

  async getAwsCredentials(awsAccountId: string): Promise<AwsCredentials> {
    logger.debug(`Fetching AWS credentials for account: ${awsAccountId}`)
    return this.get<AwsCredentials>(API_ENDPOINTS.AWS_CREDENTIALS(this.tenantCode), { params: { awsAccountId } })
  }

  async getDbCredentials(name: string): Promise<DbCredentials> {
    logger.debug(`Fetching DB credentials for: ${name}`)
    return this.get<DbCredentials>(API_ENDPOINTS.DB_CREDENTIALS(this.tenantCode), { params: { name } })
  }

  async getSshCredentials(hostId: string): Promise<SshCredentials> {
    logger.debug(`Fetching SSH credentials for host: ${hostId}`)
    return this.get<SshCredentials>(API_ENDPOINTS.SSH_CREDENTIALS(this.tenantCode, hostId))
  }

  /**
   * JIT SSH credential lookup for a `server_setup_exec` command. The target
   * host is resolved server-side from the command's payload (never from a
   * client-supplied hostId), so this can safely be called with either an
   * ECS oneshot token or a resident agent's normal token. The response may
   * carry Tailscale SOCKS5 fields (connectionType / tailnetHostname /
   * socksPort / tailscaleAuthKey) the same way `getSshExecCredential`'s does
   * — see `SshExecCredential` and `server-setup-runner.ts`'s
   * `buildInventory`. Never log the returned credential; only log the
   * commandId.
   */
  async getServerSetupSshCredential(commandId: string, agentId: string): Promise<SshExecCredential> {
    this.validateCommandId(commandId)
    logger.debug(`Fetching server setup SSH credential for command: ${commandId}`)
    return this.get<SshExecCredential>(
      API_ENDPOINTS.SERVER_SETUP_SSH_CREDENTIAL(this.tenantCode, commandId),
      { params: { agentId } },
    )
  }

  /**
   * JIT lookup of project (`ANSIBLE#`-prefixed `ConfigSetting`) variables for
   * a `server_setup_exec` command's custom Ansible tasks. Mirrors
   * `getServerSetupSshCredential`'s IDOR-prevention design: `projectCode` is
   * resolved server-side from the command's `requestContext`, never passed
   * by the caller. `secretNames` in the response drives `no_log: true`
   * annotation (`ansible-task-guard.ts`) and post-execution redaction
   * (`server-setup-runner.ts`) — never log the returned `variables` values.
   */
  async getServerSetupVariables(commandId: string, agentId: string): Promise<ServerSetupVariablesResponse> {
    this.validateCommandId(commandId)
    logger.debug(`Fetching server setup variables for command: ${commandId}`)
    return this.get<ServerSetupVariablesResponse>(
      API_ENDPOINTS.SERVER_SETUP_VARIABLES(this.tenantCode, commandId),
      { params: { agentId } },
    )
  }

  /**
   * JIT SSH credential lookup for an `ssh_exec` command. Mirrors
   * `getServerSetupSshCredential`'s commandId-scoped design: the target host
   * is resolved server-side from the command's payload, so this can safely
   * be called with either an ECS oneshot token or a resident agent's normal
   * token. The response may carry Tailscale SOCKS5 fields (connectionType /
   * tailnetHostname / socksPort / tailscaleAuthKey) — see `SshExecCredential`.
   * Never log the returned credential; only log the commandId.
   */
  async getSshExecCredential(commandId: string, agentId: string): Promise<SshExecCredential> {
    this.validateCommandId(commandId)
    logger.debug(`Fetching SSH exec credential for command: ${commandId}`)
    return this.get<SshExecCredential>(
      API_ENDPOINTS.SSH_EXEC_CREDENTIAL(this.tenantCode, commandId),
      { params: { agentId } },
    )
  }

  async getBrowserCredentials(name: string): Promise<BrowserCredentials> {
    logger.debug(`Fetching browser credentials for: ${name}`)
    return this.get<BrowserCredentials>(API_ENDPOINTS.BROWSER_CREDENTIALS(this.tenantCode), { params: { name } })
  }

  async getE2eEnvironmentVariables(environmentId: string): Promise<Record<string, string>> {
    logger.debug(`Fetching E2E environment variables for: ${environmentId}`)
    const response = await this.get<E2eEnvironmentVariablesResponse>(
      API_ENDPOINTS.E2E_ENV_VARIABLES(this.tenantCode),
      { params: { environmentId } },
    )
    return response.variables
  }

  async getRepoCredentials(repositoryId: string): Promise<RepoCredentials> {
    logger.debug(`Fetching repo credentials for: ${repositoryId}`)
    return this.get<RepoCredentials>(API_ENDPOINTS.REPO_CREDENTIALS(this.tenantCode, repositoryId))
  }

  async submitChatChunk(
    commandId: string,
    chunk: ChatChunk,
    agentId: string,
  ): Promise<void> {
    this.validateCommandId(commandId)
    logger.debug(`Submitting chat chunk ${chunk.index} (${chunk.type}) for command: ${commandId}`)
    await this.postVoid(API_ENDPOINTS.COMMAND_CHUNKS(this.tenantCode, commandId), chunk, { params: { agentId } })
  }

  async submitLogChunk(params: {
    agentId: string
    projectCode: string
    logType: 'docker-build' | 'container'
    sessionId: string
    seq: number
    text: string
  }): Promise<void> {
    await this.postVoid(API_ENDPOINTS.LOG_CHUNK(this.tenantCode), params)
  }

  async saveSessionLog(params: {
    agentId: string
    projectCode: string
    logType: 'docker-build' | 'container'
    sessionId: string
    content: string
  }): Promise<void> {
    await this.postVoid(API_ENDPOINTS.LOG_SESSION(this.tenantCode), params, {
      timeout: 30_000,
    })
  }

  async getUploadUrl(data: {
    conversationId: string
    messageId: string
    filename: string
    contentType: string
    fileSize: number
    projectCode: string
  }): Promise<{ uploadUrl: string; fileId: string; s3Key: string }> {
    logger.debug(`Requesting upload URL for file: ${data.filename}`)
    return this.post<{ uploadUrl: string; fileId: string; s3Key: string }>(
      API_ENDPOINTS.FILES_UPLOAD_URL(this.tenantCode, this.projectCode),
      data,
    )
  }

  async getDownloadUrl(data: {
    fileId: string
    s3Key: string
  }): Promise<{ downloadUrl: string }> {
    logger.debug(`Requesting download URL for file: ${data.fileId}`)
    return this.post<{ downloadUrl: string }>(
      API_ENDPOINTS.FILES_DOWNLOAD_URL(this.tenantCode, this.projectCode),
      data,
    )
  }

  // === E2E Test ===

  async updateE2eExecutionStatus<B = Record<string, unknown>>(
    tenantCode: string,
    projectCode: string,
    executionId: string,
    body: B,
  ): Promise<void> {
    await this.putVoid(
      API_ENDPOINTS.E2E_EXECUTION_STATUS(tenantCode, projectCode, executionId),
      body,
    )
  }

  async reportE2eTestStep<B = Record<string, unknown>>(
    tenantCode: string,
    projectCode: string,
    executionId: string,
    body: B,
  ): Promise<void> {
    await this.postVoid(
      API_ENDPOINTS.E2E_EXECUTION_STEPS(tenantCode, projectCode, executionId),
      body,
    )
  }

  async updateE2eTestScript<B = Record<string, unknown>>(
    tenantCode: string,
    projectCode: string,
    executionId: string,
    body: B,
  ): Promise<void> {
    await this.putVoid(
      API_ENDPOINTS.E2E_EXECUTION_SCRIPT(tenantCode, projectCode, executionId),
      body,
    )
  }

  // === Alert (CloudWatch Alarm) ===

  /**
   * pending のアラートのみを取得する（通常の高頻度ポーリング用）。
   * processing のアラートは含めない。これにより、処理が完了しない（processing で
   * 止まった）アラートを毎回拾って再処理する無限ループを防ぐ。
   */
  async getPendingAlerts(
    tenantCode: string,
    projectCode: string,
  ): Promise<{ items: PendingAlert[]; total: number }> {
    return this.get(API_ENDPOINTS.ALERTS(tenantCode, projectCode), {
      params: { status: 'pending', limit: 20 },
    })
  }

  /**
   * 指定分数以上 processing のままスタックしたアラートを取得する
   * （低頻度のスタック救済フロー専用）。
   * 通常ポーリング（getPendingAlerts）とは分離し、再処理の頻度を抑える。
   */
  async getStaleProcessingAlerts(
    tenantCode: string,
    projectCode: string,
    staleProcessingMinutes: number,
  ): Promise<{ items: PendingAlert[]; total: number }> {
    return this.get(API_ENDPOINTS.ALERTS(tenantCode, projectCode), {
      params: { status: 'pending', staleProcessingMinutes, limit: 20 },
    })
  }

  async getAlert(
    tenantCode: string,
    projectCode: string,
    alertNumber: string,
  ): Promise<PendingAlert | null> {
    try {
      return await this.get<PendingAlert>(
        API_ENDPOINTS.ALERT(tenantCode, projectCode, alertNumber),
      )
    } catch (error) {
      logger.warn('Failed to fetch alert', {
        tenantCode,
        projectCode,
        alertNumber,
        error: toErrorMessage(error),
      })
      return null
    }
  }

  async updateAlertStatus(
    tenantCode: string,
    projectCode: string,
    alertNumber: string,
    body: { status: string; issueId?: string; failureReason?: string },
  ): Promise<void> {
    await this.putVoid(
      API_ENDPOINTS.ALERT_STATUS(tenantCode, projectCode, alertNumber),
      body,
    )
  }

  /** 同じ alarmName の未解決 Issue（open/received/in_progress）を検索する */
  async findActiveIssueByAlarmName(
    tenantCode: string,
    projectCode: string,
    alarmName: string,
  ): Promise<{ id: string } | null> {
    return this.get<{ id: string } | null>(
      API_ENDPOINTS.ALERT_ACTIVE_ISSUE(tenantCode, projectCode),
      { params: { alarmName } },
    )
  }

  /** OK 通知（アラーム解除）時に既存 Issue を resolved に更新する */
  async resolveIssueFromAlert(
    tenantCode: string,
    projectCode: string,
    alertNumber: string,
    issueId: string,
  ): Promise<void> {
    await this.postVoid(
      API_ENDPOINTS.ALERT_RESOLVE_ISSUE(tenantCode, projectCode, alertNumber),
      { issueId },
    )
  }

  // === ECS execution agent ===

  /**
   * Register (or overwrite on re-publish) an ECS execution agent.
   * The API only validates and persists the AGENT record; it never calls AWS.
   */
  async registerEcsAgent(registration: EcsAgentRegistration): Promise<void> {
    logger.debug(`Registering ECS agent: ${registration.agentId}`)
    await this.postVoid(API_ENDPOINTS.ECS_AGENTS(this.tenantCode), registration)
  }

  // === Agent tools (Slack / alarm trigger) ===

  // callId identifies one logical tool invocation; the caller generates it once so that
  // retries of this same post() call (see RetryStrategy.withRetry) resend an identical value.
  async sendSlackMessage(channel: string, message: string, threadTs?: string, callId?: string): Promise<SendSlackMessageResult> {
    logger.debug(`Sending Slack message to channel: ${channel}`)
    return this.post<SendSlackMessageResult>(
      API_ENDPOINTS.AGENT_TOOL_SEND_SLACK_MESSAGE(this.tenantCode),
      { channel, message, threadTs, callId },
    )
  }

  // ファイル内容を含むボディは最大10MB（api側 src/main.ts の express.json 上限）かつ
  // Slack files.uploadV2 は複数回のAPI往復を伴うため、既定の10秒タイムアウトでは
  // 大きめのファイルで打ち切られやすい。saveSessionLog と同様に専用タイムアウトを設定する。
  async sendSlackFile(channel: string, fileName: string, content: string, threadTs?: string, callId?: string): Promise<SendSlackFileResult> {
    logger.debug(`Sending Slack file to channel: ${channel}`)
    return this.post<SendSlackFileResult>(
      API_ENDPOINTS.AGENT_TOOL_SEND_SLACK_FILE(this.tenantCode),
      { channel, fileName, content, threadTs, callId },
      { timeout: 60_000 },
    )
  }

  /**
   * 現在処理中のSlackスレッドの全文を読み取る（自ボットの過去投稿を含む）。
   *
   * `chatConversationId` は `send_slack_message`/`trigger_alarm` の `callId`
   * （呼び出し単位の冪等キー）とは別物で、実際のSlackチャット会話ID
   * （`SlackThreadMapping.conversationId`）そのものを渡す。
   */
  async readSlackThread(chatConversationId: string): Promise<ReadSlackThreadResult> {
    logger.debug(`Reading Slack thread for conversation: ${chatConversationId}`)
    return this.post<ReadSlackThreadResult>(
      API_ENDPOINTS.AGENT_TOOL_READ_SLACK_THREAD(this.tenantCode),
      { chatConversationId },
    )
  }

  async triggerAlarm(
    title: string,
    reason: string,
    priority?: 'urgent' | 'high' | 'medium' | 'low',
    callId?: string,
  ): Promise<TriggerAlarmResult> {
    logger.debug(`Triggering alarm: ${title}`)
    return this.post<TriggerAlarmResult>(
      API_ENDPOINTS.AGENT_TOOL_TRIGGER_ALARM(this.tenantCode),
      { title, reason, priority, callId },
    )
  }

  /**
   * タスク実行中の CLI エージェントが E2E テストを起動する。
   *
   * `taskId` を渡すことで、起動した E2E 実行がそのタスクに紐付き、
   * タスク詳細画面の E2E テストタブから逆引きできるようになる。
   */
  async triggerE2eTest(
    testCaseId: string,
    taskId: string,
    executionMethod?: 'ai' | 'script' | 'hybrid' | 'playwright',
    environmentId?: string,
    callId?: string,
  ): Promise<TriggerE2eTestResult> {
    logger.debug(`Triggering E2E test: testCaseId=${testCaseId} taskId=${taskId}`)
    return this.post<TriggerE2eTestResult>(
      API_ENDPOINTS.AGENT_TOOL_TRIGGER_E2E_TEST(this.tenantCode),
      { testCaseId, taskId, executionMethod, environmentId, callId },
    )
  }

  /**
   * システムのナレッジベースへ登録・改訂する（`update_system_knowledge` MCPツール専用）。
   *
   * `id` を指定すると改訂、未指定なら新規作成として扱われる。他の `agent/tools/*`
   * エンドポイントと異なり `{success, data, error}` ではなく、成功時（201）はナレッジ詳細
   * オブジェクトを直接返す。失敗時（4xx/5xx・ネットワークエラー）は例外を投げる
   * （呼び出し元は `withMcpErrorHandling` でエラーレスポンスに変換し、ローカルファイルへの
   * フォールバックは行わない）。
   */
  async updateSystemKnowledge(
    request: UpdateSystemKnowledgeRequest,
  ): Promise<UpdateSystemKnowledgeResult> {
    logger.debug(`Updating system knowledge: title="${request.title}"${request.id ? ` (revision of ${request.id})` : ''}`)
    return this.post<UpdateSystemKnowledgeResult>(
      API_ENDPOINTS.AGENT_KNOWLEDGE(this.tenantCode),
      request,
    )
  }
}
