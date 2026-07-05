/**
 * Oneshot runner (ECS container mode).
 *
 * When the CLI starts with AGENT_MODE=oneshot (set via containerOverrides at
 * ECS RunTask time), it does NOT run the resident agent flow. Instead it:
 *   getCommand(COMMAND_ID) -> executeCommand -> submitResult -> exit
 *
 * There is no AppSync subscription, no heartbeat, and no register call.
 * Authentication uses the short-lived oneshot token (AGENT_ONESHOT_TOKEN)
 * scoped to the single COMMAND_ID. The token value is never logged.
 */

import { ApiClient } from './api-client'
import { executeCommand } from './commands'
import { ONESHOT_ENV_VARS } from './constants'
import { logger } from './logger'
import { type AgentCommand, type AgentCommandType, type CommandResult, errorResult } from './types'
import { getErrorMessage } from './utils'

/**
 * Command types the ECS oneshot runner is allowed to execute (Phase 1).
 * The API only dispatches `execute_command` to ECS execution agents, but the
 * runner enforces the same allowlist defensively: a mis-dispatched `chat` /
 * `e2e_test` / `file_*` would otherwise run with a near-empty execution
 * context (no projectDir/mcpConfigPath/serverConfig/browser callbacks) and
 * silently misbehave. Anything outside this set is rejected up front.
 */
const ONESHOT_SUPPORTED_COMMAND_TYPES: ReadonlySet<AgentCommandType> = new Set<AgentCommandType>([
  'execute_command',
])

/**
 * Working directory for `execute_command` in the container. The ECS image
 * sets WORKDIR /workspace; fall back to that when the shell executor would
 * otherwise default to an undefined cwd.
 */
const ONESHOT_DEFAULT_CWD = '/workspace'

const REQUIRED_ENV_KEYS = [
  ONESHOT_ENV_VARS.COMMAND_ID,
  ONESHOT_ENV_VARS.AGENT_ID,
  ONESHOT_ENV_VARS.TENANT_CODE,
  ONESHOT_ENV_VARS.PROJECT_CODE,
  ONESHOT_ENV_VARS.API_BASE_URL,
  ONESHOT_ENV_VARS.AGENT_ONESHOT_TOKEN,
] as const

interface OneshotEnv {
  commandId: string
  agentId: string
  tenantCode: string
  projectCode: string
  apiBaseUrl: string
  token: string
}

/**
 * Read and validate the oneshot environment.
 * Missing variables are a clear fatal error (no fallback).
 */
export function readOneshotEnv(env: NodeJS.ProcessEnv = process.env): OneshotEnv {
  const missing = REQUIRED_ENV_KEYS.filter((key) => !env[key])
  if (missing.length > 0) {
    throw new Error(`Oneshot mode requires environment variables: ${missing.join(', ')}`)
  }
  return {
    commandId: env[ONESHOT_ENV_VARS.COMMAND_ID] as string,
    agentId: env[ONESHOT_ENV_VARS.AGENT_ID] as string,
    tenantCode: env[ONESHOT_ENV_VARS.TENANT_CODE] as string,
    projectCode: env[ONESHOT_ENV_VARS.PROJECT_CODE] as string,
    apiBaseUrl: env[ONESHOT_ENV_VARS.API_BASE_URL] as string,
    token: env[ONESHOT_ENV_VARS.AGENT_ONESHOT_TOKEN] as string,
  }
}

/**
 * Run exactly one command and return the process exit code
 * (0 = executed and submitted successfully, 1 = any failure).
 */
export async function runOneshot(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let oneshotEnv: OneshotEnv
  try {
    oneshotEnv = readOneshotEnv(env)
  } catch (error) {
    logger.error(`[oneshot] ${getErrorMessage(error)}`)
    return 1
  }

  const { commandId, agentId, tenantCode, projectCode, apiBaseUrl } = oneshotEnv
  logger.info(`[oneshot] Starting oneshot execution: commandId=${commandId} agentId=${agentId}`)

  let client: ApiClient
  try {
    client = new ApiClient(apiBaseUrl, oneshotEnv.token)
  } catch (error) {
    logger.error(`[oneshot] Failed to initialize API client: ${getErrorMessage(error)}`)
    return 1
  }
  // The oneshot token uses the same "{tenantCode}:{tokenId}:{secret}" format
  // as resident agent tokens, so the ApiClient constructor already derives a
  // tenant code from it. TENANT_CODE from the environment is still applied
  // explicitly as the authoritative value (dispatch injects both together).
  client.setTenantCode(tenantCode)
  client.setProjectCode(projectCode)

  const submit = async (result: CommandResult): Promise<boolean> => {
    try {
      await client.submitResult(commandId, result, agentId)
      return true
    } catch (error) {
      logger.error(`[oneshot] Failed to submit result: ${getErrorMessage(error)}`)
      return false
    }
  }

  let command: AgentCommand
  try {
    command = await client.getCommand(commandId, agentId)
  } catch (error) {
    const message = `Failed to fetch command ${commandId}: ${getErrorMessage(error)}`
    logger.error(`[oneshot] ${message}`)
    // Best effort: let the API mark the work command as failed right away
    // instead of waiting for the timeout sweep.
    await submit(errorResult(message))
    return 1
  }

  if (!ONESHOT_SUPPORTED_COMMAND_TYPES.has(command.type)) {
    const supported = [...ONESHOT_SUPPORTED_COMMAND_TYPES].join(', ')
    const message = `Command type "${command.type}" is not supported in ECS oneshot mode (supported: ${supported})`
    logger.error(`[oneshot] ${message}`)
    // Submit as a visible failure rather than running with an incomplete
    // execution context and misbehaving silently.
    await submit(errorResult(message))
    return 1
  }

  // execute_command's shell executor falls back to os.homedir() when cwd is
  // absent; pin it to the container's working dir for predictable behavior.
  const payload = { ...command.payload }
  if (payload.cwd === undefined || payload.cwd === null || payload.cwd === '') {
    payload.cwd = ONESHOT_DEFAULT_CWD
  }

  logger.info(`[oneshot] Executing command: type=${command.type}`)
  const result = await executeCommand(command.type, payload, {
    commandId,
    client,
    agentId,
    tenantCode,
  })

  const submitted = await submit(result)
  if (!submitted) return 1

  if (!result.success) {
    logger.error('[oneshot] Command execution failed; result submitted')
    return 1
  }
  logger.success('[oneshot] Command executed and result submitted')
  return 0
}

/**
 * Entry-point wrapper used by src/index.ts: runs the oneshot flow and exits
 * the process with the resulting code. Any unexpected rejection is converted
 * into exit code 1 — a container that never exits would only be reclaimed by
 * the slow timeout sweep. The runner is injectable for tests.
 */
export async function runOneshotFromEnv(runner: () => Promise<number> = runOneshot): Promise<void> {
  let exitCode = 1
  try {
    exitCode = await runner()
  } catch (error) {
    logger.error(`[oneshot] Fatal error: ${getErrorMessage(error)}`)
    exitCode = 1
  }
  process.exit(exitCode)
}
