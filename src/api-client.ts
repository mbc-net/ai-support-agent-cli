import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'

import { AGENT_VERSION, API_BASE_DELAY_MS, API_ENDPOINTS, API_MAX_RETRIES, API_REQUEST_TIMEOUT } from './constants'
import { logger } from './logger'
import { RetryStrategy } from './retry-strategy'
import type {
  AgentCommand,
  AgentServerConfig,
  AwsCredentials,
  ChatChunk,
  CommandResult,
  DbCredentials,
  HeartbeatResponse,
  PendingCommand,
  ProjectConfigResponse,
  ReleaseChannel,
  RegisterRequest,
  RegisterResponse,
  SystemInfo,
  VersionInfo,
} from './types'

export class ApiClient {
  private readonly client: AxiosInstance
  private readonly retry: RetryStrategy

  constructor(apiUrl: string, token: string) {
    const parsed = new URL(apiUrl)
    if (parsed.protocol === 'http:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      logger.warn('API URL uses HTTP (not HTTPS). Token may be transmitted in plain text.')
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
    return this.post<RegisterResponse>(API_ENDPOINTS.REGISTER, {
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
  ): Promise<HeartbeatResponse | void> {
    logger.debug('Sending heartbeat')
    return this.post<HeartbeatResponse>(API_ENDPOINTS.HEARTBEAT, {
      agentId,
      timestamp: Date.now(),
      version: AGENT_VERSION,
      systemInfo,
      ...(updateError && { updateError }),
      ...(availableChatModes !== undefined && { availableChatModes }),
      ...(activeChatMode !== undefined && { activeChatMode }),
      ...(ipAddress && { ipAddress }),
    })
  }

  async getVersionInfo(channel: ReleaseChannel = 'latest'): Promise<VersionInfo> {
    return this.get<VersionInfo>(`${API_ENDPOINTS.VERSION}?channel=${channel}`)
  }

  async getPendingCommands(agentId: string): Promise<PendingCommand[]> {
    logger.debug('Polling for pending commands')
    return this.get<PendingCommand[]>(API_ENDPOINTS.COMMANDS_PENDING, { params: { agentId } })
  }

  private validateCommandId(commandId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(commandId)) {
      throw new Error(`Invalid command ID format: ${commandId}`)
    }
  }

  async getCommand(commandId: string, agentId: string): Promise<AgentCommand> {
    this.validateCommandId(commandId)
    logger.debug(`Fetching command: ${commandId}`)
    return this.get<AgentCommand>(API_ENDPOINTS.COMMAND(commandId), { params: { agentId } })
  }

  async submitResult(
    commandId: string,
    result: CommandResult,
    agentId: string,
  ): Promise<void> {
    this.validateCommandId(commandId)
    logger.debug(`Submitting result for command: ${commandId}`)
    await this.postVoid(API_ENDPOINTS.COMMAND_RESULT(commandId), result, { params: { agentId } })
  }

  async reportConnectionStatus(
    agentId: string,
    status: 'connected' | 'disconnected',
  ): Promise<void> {
    await this.postVoid(API_ENDPOINTS.CONNECTION_STATUS, {
      agentId,
      status,
      timestamp: Date.now(),
    })
  }

  async getConfig(): Promise<AgentServerConfig> {
    logger.debug('Fetching agent config from server')
    return this.get<AgentServerConfig>(API_ENDPOINTS.CONFIG)
  }

  async getProjectConfig(): Promise<ProjectConfigResponse> {
    logger.debug('Fetching project config from server')
    return this.get<ProjectConfigResponse>(API_ENDPOINTS.PROJECT_CONFIG)
  }

  async getAwsCredentials(awsAccountId: string): Promise<AwsCredentials> {
    logger.debug(`Fetching AWS credentials for account: ${awsAccountId}`)
    return this.get<AwsCredentials>(API_ENDPOINTS.AWS_CREDENTIALS, { params: { awsAccountId } })
  }

  async getDbCredentials(name: string): Promise<DbCredentials> {
    logger.debug(`Fetching DB credentials for: ${name}`)
    return this.get<DbCredentials>(API_ENDPOINTS.DB_CREDENTIALS, { params: { name } })
  }

  async submitChatChunk(
    commandId: string,
    chunk: ChatChunk,
    agentId: string,
  ): Promise<void> {
    this.validateCommandId(commandId)
    logger.debug(`Submitting chat chunk ${chunk.index} (${chunk.type}) for command: ${commandId}`)
    await this.postVoid(API_ENDPOINTS.COMMAND_CHUNKS(commandId), chunk, { params: { agentId } })
  }
}
