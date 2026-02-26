import axios, { type AxiosInstance } from 'axios'

import { AGENT_VERSION, API_BASE_DELAY_MS, API_ENDPOINTS, API_MAX_RETRIES, API_REQUEST_TIMEOUT } from './constants'
import { logger } from './logger'
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
  }

  private shouldRetry(error: unknown): boolean {
    if (!axios.isAxiosError(error) || !error.response) {
      return true // Network error — retry
    }
    const status = error.response.status
    if (status === 408 || status === 429) {
      return true // Timeout / rate-limit — retry
    }
    if (status >= 500) {
      return true // Server error — retry
    }
    return false // Other 4xx — do not retry
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown
    for (let attempt = 0; attempt < API_MAX_RETRIES; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error
        if (!this.shouldRetry(error)) {
          throw error
        }
        if (attempt < API_MAX_RETRIES - 1) {
          const baseDelay = API_BASE_DELAY_MS * Math.pow(2, attempt)
          const delay = Math.round(baseDelay * (0.5 + Math.random() * 0.5))
          logger.debug(`Request failed (attempt ${attempt + 1}/${API_MAX_RETRIES}), retrying in ${delay}ms`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }
    throw lastError
  }

  async register(request: RegisterRequest): Promise<RegisterResponse> {
    logger.debug(`Registering agent: ${request.agentId}`)
    return this.withRetry(async () => {
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
    await this.withRetry(async () => {
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
    return this.withRetry(async () => {
      const { data } = await this.client.get<VersionInfo>(
        `${API_ENDPOINTS.VERSION}?channel=${channel}`,
      )
      return data
    })
  }

  async getPendingCommands(agentId: string): Promise<PendingCommand[]> {
    logger.debug('Polling for pending commands')
    return this.withRetry(async () => {
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
    return this.withRetry(async () => {
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
    await this.withRetry(async () => {
      await this.client.post(API_ENDPOINTS.COMMAND_RESULT(commandId), result, {
        params: { agentId },
      })
    })
  }

  async reportConnectionStatus(
    agentId: string,
    status: 'connected' | 'disconnected',
  ): Promise<void> {
    await this.withRetry(async () => {
      await this.client.post(API_ENDPOINTS.CONNECTION_STATUS, {
        agentId,
        status,
        timestamp: Date.now(),
      })
    })
  }

  async getConfig(): Promise<AgentServerConfig> {
    logger.debug('Fetching agent config from server')
    return this.withRetry(async () => {
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
    await this.withRetry(async () => {
      await this.client.post(API_ENDPOINTS.COMMAND_CHUNKS(commandId), chunk, {
        params: { agentId },
      })
    })
  }
}
