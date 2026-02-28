import { spawn } from 'child_process'
import * as os from 'os'

import { CMD_DEFAULT_TIMEOUT, ERR_NO_COMMAND_SPECIFIED, MAX_CMD_TIMEOUT, MAX_OUTPUT_SIZE } from '../constants'
import { buildSafeEnv, validateCommand, validateFilePath } from '../security'
import type { CommandResult, ShellCommandPayload } from '../types'
import { parseNumber, parseString } from '../utils'

export async function executeShellCommand(
  payload: ShellCommandPayload,
): Promise<CommandResult> {
  const command = parseString(payload.command)
  if (!command) {
    return { success: false, error: ERR_NO_COMMAND_SPECIFIED }
  }

  const validationError = validateCommand(command)
  if (validationError) {
    return { success: false, error: validationError }
  }

  const rawTimeout = parseNumber(payload.timeout) ?? CMD_DEFAULT_TIMEOUT
  if (rawTimeout < 1 || rawTimeout > MAX_CMD_TIMEOUT) {
    return { success: false, error: `Timeout must be between 1 and ${MAX_CMD_TIMEOUT}ms` }
  }
  const timeout = rawTimeout
  const cwd = parseString(payload.cwd) ?? os.homedir()

  const cwdError = await validateFilePath(cwd)
  if (cwdError) {
    return { success: false, error: cwdError }
  }

  return new Promise((resolve) => {
    let resolved = false

    const shellCmd = os.platform() === 'win32' ? 'cmd.exe' : '/bin/sh'
    const shellArgs = os.platform() === 'win32' ? ['/c', command] : ['-c', command]
    const proc = spawn(shellCmd, shellArgs, {
      cwd,
      env: buildSafeEnv(),
    })

    let stdout = ''
    let stderr = ''
    let outputSize = 0

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        proc.kill('SIGKILL')
        resolve({ success: false, error: `Command timed out after ${timeout}ms` })
      }
    }, timeout)

    proc.stdout?.on('data', (data: Buffer) => {
      outputSize += data.length
      if (outputSize <= MAX_OUTPUT_SIZE) {
        stdout += data.toString()
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      outputSize += data.length
      if (outputSize <= MAX_OUTPUT_SIZE) {
        stderr += data.toString()
      }
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (resolved) return
      resolved = true

      const truncated = outputSize > MAX_OUTPUT_SIZE
      const suffix = truncated ? '\n... [output truncated]' : ''

      if (code === 0) {
        resolve({ success: true, data: stdout + suffix })
      } else {
        resolve({
          success: false,
          data: stdout + suffix,
          error: stderr || `Process exited with code ${code}`,
        })
      }
    })

    proc.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (resolved) return
      resolved = true
      let errorMessage = err.message
      if (err.code === 'ENOENT') {
        errorMessage = `Command not found: ${shellCmd}`
      } else if (err.code === 'EACCES') {
        errorMessage = `Permission denied: ${shellCmd}`
      }
      resolve({ success: false, error: errorMessage })
    })
  })
}
