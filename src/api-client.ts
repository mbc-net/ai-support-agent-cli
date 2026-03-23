import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'

import { AGENT_VERSION, API_BASE_DELAY_MS, API_ENDPOINTS, API_MAX_RETRIES, API_REQUEST_TIMEOUT, DEFAULT_API_URL } from './constants'
import { logger } from './logger'
import { RetryStrategy } from './retry-strategy'
import type {
  AgentCommand,
  AgentServerConfig,
  AwsCredentials,
  BrowserCredentials,
  ChatChunk,
  CommandResult,
  DbCredentials,
  HeartbeatResponse,
  PendingCommand,
  ProjectConfigResponse,
  ReleaseChannel,
  RegisterRequest,
  RegisterResponse,
  RepoCredentials,
  SshCredentials,
  SystemInfo,
  VersionInfo,
} from './types'

export class ApiClient {
  private readonly client: AxiosInstance
  private readonly retry: RetryStrategy
  private tenantCode = ''
  private projectCode = ''

  constructor(apiUrl: string, token: string) {
    const parsed = new URL(apiUrl)
    if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      if (process.env.AI_SUPPORT_AGENT_ALLOW_HTTP === 'true') {
        logger.warn('API URL uses HTTP (not HTTPS). Token may be transmitted in plain text.')
      } else {
        throw new Error(
          'API URL uses HTTP (not HTTPS). Set AI_SUPPORT_AGENT_ALLOW_HTTP=true to allow insecure connections.',
        )
      }
    }

    // Parse tenantCode from token format: {tenantCode}:{tokenId}:{rawToken}
    const tokenParts = token.split(':')
    if (tokenParts.length >= 3) {
      this.tenantCode = tokenParts[0]
    }

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

  setProjectCode(code: string): void {
    this.projectCode = code
  }

  updateToken(newToken: string): void {
    this.client.defaults.headers['Authorization'] = `Bearer ${newToken}`

    // Re-extract tenantCode from new token format: {tenantCode}:{tokenId}:{rawToken}
    const tokenParts = newToken.split(':')
    if (tokenParts.length >= 3) {
      this.tenantCode = tokenParts[0]
    }
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

  async getBrowserCredentials(name: string): Promise<BrowserCredentials> {
    logger.debug(`Fetching browser credentials for: ${name}`)
    return this.get<BrowserCredentials>(API_ENDPOINTS.BROWSER_CREDENTIALS(this.tenantCode), { params: { name } })
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
}
