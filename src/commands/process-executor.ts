import * as os from 'os'

import { ERR_INVALID_PID, PROCESS_LIST_TIMEOUT } from '../constants'
import { ALLOWED_SIGNALS } from '../security'
import { type CommandResult, errorResult, type ProcessKillPayload, successResult } from '../types'
import { getErrorMessage, parseNumber, parseString } from '../utils'

import { executeShellCommand } from './shell-executor'

export function processList(): Promise<CommandResult> {
  const command = os.platform() === 'win32'
    ? 'tasklist /fo csv /nh'
    : 'ps aux'

  return executeShellCommand({ command, timeout: PROCESS_LIST_TIMEOUT })
}

export async function processKill(
  payload: ProcessKillPayload,
): Promise<CommandResult> {
  const pid = parseNumber(payload.pid)
  if (!pid || pid < 1 || !Number.isInteger(pid)) {
    return errorResult(ERR_INVALID_PID)
  }

  const signal = parseString(payload.signal) ?? 'SIGTERM'

  if (!ALLOWED_SIGNALS.has(signal)) {
    return errorResult(`Signal not allowed: ${signal}. Allowed: ${[...ALLOWED_SIGNALS].join(', ')}`)
  }

  try {
    process.kill(pid, signal)
    return successResult(`Sent ${signal} to PID ${pid}`)
  } catch (error) {
    return errorResult(getErrorMessage(error))
  }
}
