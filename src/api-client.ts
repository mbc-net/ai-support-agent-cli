import axios, { type AxiosInstance } from 'axios'

import { AGENT_VERSION, API_BASE_DELAY_MS, API_ENDPOINTS, API_MAX_RETRIES, API_REQUEST_TIMEOUT } from './constants'
import { logger } from './logger'
import { RetryStrategy } from './retry-strategy'
import type {
  AgentCommand,
  AgentServerConfig,
  ChatChunk,
  CommandResult,
  PendingCommand,
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

  async register(request: RegisterRequest): Promise<RegisterResponse> {
    logger.debug(`Registering agent: ${request.agentId}`)
    return this.retry.withRetry(async () => {
      const { ipAddress, availableChatModes, activeChatMode, ...rest } = request
      const { data } = await this.client.post<RegisterResponse>(
        API_ENDPOINTS.REGISTER,
        {
          ...rest,
          version: AGENT_VERSION,
          ...(ipAddress && { ipAddress }),
          ...(availableChatModes !== undefined && { availableChatModes }),
          ...(activeChatMode !== undefined && { activeChatMode }),
        },
      )
      return data
    })
  }

  async heartbeat(
    agentId: string,
    systemInfo: SystemInfo,
    updateError?: string,
    availableChatModes?: string[],
    activeChatMode?: string,
  ): Promise<void> {
    logger.debug('Sending heartbeat')
    await this.retry.withRetry(async () => {
      await this.client.post(API_ENDPOINTS.HEARTBEAT, {
        agentId,
        timestamp: Date.now(),
        version: AGENT_VERSION,
        systemInfo,
        ...(updateError && { updateError }),
        ...(availableChatModes !== undefined && { availableChatModes }),
        ...(activeChatMode !== undefined && { activeChatMode }),
      })
    })
  }

  async getVersionInfo(channel: ReleaseChannel = 'latest'): Promise<VersionInfo> {
    return this.retry.withRetry(async () => {
      const { data } = await this.client.get<VersionInfo>(
        `${API_ENDPOINTS.VERSION}?channel=${channel}`,
      )
      return data
    })
  }

  async getPendingCommands(agentId: string): Promise<PendingCommand[]> {
    logger.debug('Polling for pending commands')
    return this.retry.withRetry(async () => {
      const { data } = await this.client.get<PendingCommand[]>(
        API_ENDPOINTS.COMMANDS_PENDING,
        { params: { agentId } },
      )
      return data
    })
  }

  private validateCommandId(commandId: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(commandId)) {
      throw new Error(`Invalid command ID format: ${commandId}`)
    }
  }

  async getCommand(commandId: string, agentId: string): Promise<AgentCommand> {
    this.validateCommandId(commandId)
    logger.debug(`Fetching command: ${commandId}`)
    return this.retry.withRetry(async () => {
      const { data } = await this.client.get<AgentCommand>(
        API_ENDPOINTS.COMMAND(commandId),
        { params: { agentId } },
      )
      return data
    })
  }

  async submitResult(
    commandId: string,
    result: CommandResult,
    agentId: string,
  ): Promise<void> {
    this.validateCommandId(commandId)
    logger.debug(`Submitting result for command: ${commandId}`)
    await this.retry.withRetry(async () => {
      await this.client.post(API_ENDPOINTS.COMMAND_RESULT(commandId), result, {
        params: { agentId },
      })
    })
  }

  async reportConnectionStatus(
    agentId: string,
    status: 'connected' | 'disconnected',
  ): Promise<void> {
    await this.retry.withRetry(async () => {
      await this.client.post(API_ENDPOINTS.CONNECTION_STATUS, {
        agentId,
        status,
        timestamp: Date.now(),
      })
    })
  }

  async getConfig(): Promise<AgentServerConfig> {
    logger.debug('Fetching agent config from server')
    return this.retry.withRetry(async () => {
      const { data } = await this.client.get<AgentServerConfig>(
        API_ENDPOINTS.CONFIG,
      )
      return data
    })
  }

  async submitChatChunk(
    commandId: string,
    chunk: ChatChunk,
    agentId: string,
  ): Promise<void> {
    this.validateCommandId(commandId)
    logger.debug(`Submitting chat chunk ${chunk.index} (${chunk.type}) for command: ${commandId}`)
    await this.retry.withRetry(async () => {
      await this.client.post(API_ENDPOINTS.COMMAND_CHUNKS(commandId), chunk, {
        params: { agentId },
      })
    })
  }
}
