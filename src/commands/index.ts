import type { ApiClient } from '../api-client'
import { ERR_CHAT_REQUIRES_CLIENT, ERR_CONFIG_SYNC_REQUIRES_CALLBACK, ERR_SETUP_REQUIRES_CALLBACK, LOG_DEBUG_LIMIT } from '../constants'
import { logger } from '../logger'
import { type AgentChatMode, type AgentCommandType, type AgentServerConfig, type CommandDispatch, type CommandResult, errorResult, type ProjectConfigResponse, successResult } from '../types'
import { getErrorMessage } from '../utils'

import { executeChatCommand } from './chat-executor'
import { fileDelete, fileList, fileMkdir, fileRead, fileRename, fileWrite } from './file-executor'
import { processKill, processList } from './process-executor'
import { executeShellCommand } from './shell-executor'

/** Options for command execution */
export interface ExecuteCommandOptions {
  commandId?: string
  client?: ApiClient
  serverConfig?: AgentServerConfig
  activeChatMode?: AgentChatMode
  agentId?: string
  projectDir?: string
  projectConfig?: ProjectConfigResponse
  mcpConfigPath?: string
  onSetup?: () => Promise<void>
  onConfigSync?: () => Promise<void>
}

// Overload: type-safe discriminated union
export async function executeCommand(command: CommandDispatch, options?: ExecuteCommandOptions): Promise<CommandResult>
// Overload: backward-compatible loose signature
export async function executeCommand(type: AgentCommandType, payload: Record<string, unknown>, options?: ExecuteCommandOptions): Promise<CommandResult>
// Implementation
export async function executeCommand(
  typeOrCommand: AgentCommandType | CommandDispatch,
  payloadOrOptions?: Record<string, unknown> | ExecuteCommandOptions,
  options?: ExecuteCommandOptions,
): Promise<CommandResult> {
  const type = typeof typeOrCommand === 'string' ? typeOrCommand : typeOrCommand.type
  // Runtime payloads come from external API, so cast is safe — runtime validation happens in each executor
  let p: Record<string, unknown>
  let opts: ExecuteCommandOptions | undefined

  if (typeof typeOrCommand === 'string') {
    p = payloadOrOptions as Record<string, unknown>
    opts = options
  } else {
    p = typeOrCommand.payload as Record<string, unknown>
    opts = payloadOrOptions as ExecuteCommandOptions | undefined
  }

  logger.debug(`Executing command: type=${type}`)
  try {
    switch (type) {
      case 'execute_command': {
        const cmd = (p as Record<string, unknown>).command
        logger.debug(`[shell] command="${String(cmd ?? '').substring(0, LOG_DEBUG_LIMIT)}"`)
        return await executeShellCommand(p)
      }
      case 'file_read': {
        const path = (p as Record<string, unknown>).path
        logger.debug(`[file_read] path="${String(path ?? '')}"`)
        return await fileRead(p)
      }
      case 'file_write': {
        const path = (p as Record<string, unknown>).path
        logger.debug(`[file_write] path="${String(path ?? '')}"`)
        return await fileWrite(p)
      }
      case 'file_list': {
        const path = (p as Record<string, unknown>).path
        logger.debug(`[file_list] path="${String(path ?? '')}"`)
        return await fileList(p)
      }
      case 'file_rename': {
        const oldPath = (p as Record<string, unknown>).oldPath
        const newPath = (p as Record<string, unknown>).newPath
        logger.debug(`[file_rename] oldPath="${String(oldPath ?? '')}" newPath="${String(newPath ?? '')}"`)
        return await fileRename(p)
      }
      case 'file_delete': {
        const deletePath = (p as Record<string, unknown>).path
        logger.debug(`[file_delete] path="${String(deletePath ?? '')}"`)
        return await fileDelete(p)
      }
      case 'file_mkdir': {
        const mkdirPath = (p as Record<string, unknown>).path
        logger.debug(`[file_mkdir] path="${String(mkdirPath ?? '')}"`)
        return await fileMkdir(p)
      }
      case 'process_list':
        return await processList()
      case 'process_kill': {
        const pid = (p as Record<string, unknown>).pid
        logger.debug(`[process_kill] pid=${String(pid ?? '')}`)
        return await processKill(p)
      }
      case 'chat':
        if (!opts?.commandId || !opts?.client) {
          return errorResult(ERR_CHAT_REQUIRES_CLIENT)
        }
        return await executeChatCommand(p, opts.commandId, opts.client, opts.serverConfig, opts.activeChatMode, opts.agentId, opts.projectDir, opts.projectConfig, opts.mcpConfigPath)
      case 'setup':
        if (!opts?.onSetup) {
          return errorResult(ERR_SETUP_REQUIRES_CALLBACK)
        }
        await opts.onSetup()
        return successResult('setup completed')
      case 'config_sync':
        if (!opts?.onConfigSync) {
          return errorResult(ERR_CONFIG_SYNC_REQUIRES_CALLBACK)
        }
        await opts.onConfigSync()
        return successResult('config sync completed')
      default:
        logger.warn(`Unknown command type: ${type}`)
        return errorResult(`Unknown command type: ${type}`)
    }
  } catch (error) {
    const message = getErrorMessage(error)
    logger.error(`Command execution failed (${type}): ${message}`)
    return errorResult(message)
  }
}

export { executeShellCommand } from './shell-executor'
export { fileDelete, fileList, fileMkdir, fileRead, fileRename, fileWrite } from './file-executor'
export { processKill, processList } from './process-executor'
