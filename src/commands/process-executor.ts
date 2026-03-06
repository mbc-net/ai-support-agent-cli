import * as os from 'os'

import { ERR_INVALID_PID, PROCESS_LIST_TIMEOUT } from '../constants'
import { ALLOWED_SIGNALS } from '../security'
import { type CommandResult, errorResult, type ProcessKillPayload, successResult } from '../types'
import { getErrorMessage, parseNumber, parseString } from '../utils'

import { executeShellCommand } from './shell-executor'

const MAX_PROCESS_LIST_SIZE = 50000 // 50KB

export async function processList(): Promise<CommandResult> {
  const command = os.platform() === 'win32'
    ? 'tasklist /fo csv /nh'
    : 'ps aux'

  const result = await executeShellCommand({ command, timeout: PROCESS_LIST_TIMEOUT })

  if (result.success && typeof result.data === 'string' && result.data.length > MAX_PROCESS_LIST_SIZE) {
    const lines = result.data.split('\n')
    const header = lines[0] ?? ''
    const truncated: string[] = [header]
    let size = header.length

    for (let i = 1; i < lines.length; i++) {
      size += lines[i].length + 1
      if (size > MAX_PROCESS_LIST_SIZE) {
        truncated.push(`\n... (${lines.length - i} more processes truncated)`)
        break
      }
      truncated.push(lines[i])
    }
    return successResult(truncated.join('\n'))
  }

  return result
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
