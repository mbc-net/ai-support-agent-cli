import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { CMD_DEFAULT_TIMEOUT, MAX_CMD_TIMEOUT, MAX_DIR_ENTRIES, MAX_FILE_READ_SIZE, MAX_FILE_WRITE_SIZE, MAX_OUTPUT_SIZE, PROCESS_LIST_TIMEOUT } from './constants'
import { logger } from './logger'
import type {
  AgentCommandType,
  CommandResult,
  FileListPayload,
  FileReadPayload,
  FileWritePayload,
  ProcessKillPayload,
  ShellCommandPayload,
} from './types'
import { getErrorMessage, parseNumber, parseString } from './utils'

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\s+\/(?!\w)/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\s*\{.*\};\s*:/,
]

const BLOCKED_PATH_PREFIXES = [
  '/etc/', '/proc/', '/sys/', '/dev/',
  // macOS: /etc → /private/etc, etc.
  '/private/etc/', '/private/var/db/',
]

function getSensitiveHomePaths(): string[] {
  const home = os.homedir()
  return ['.ssh', '.aws', '.gnupg', '.config/gcloud'].map(
    (dir) => path.join(home, dir) + '/',
  )
}

const ALLOWED_SIGNALS: ReadonlySet<string> = new Set([
  'SIGTERM', 'SIGUSR1', 'SIGUSR2', 'SIGINT', 'SIGHUP',
])

const SAFE_ENV_KEYS: readonly string[] = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_MESSAGES',
  'TERM', 'TMPDIR', 'TMP', 'TEMP', 'NODE_ENV',
  // Windows
  'SystemRoot', 'USERPROFILE', 'APPDATA', 'PATHEXT', 'COMSPEC',
]

function buildSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key]!
  }
  return env
}

function validateCommand(command: string): string | null {
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      return `Blocked dangerous command pattern: ${pattern}`
    }
  }
  return null
}

async function validateFilePath(filePath: string): Promise<string | null> {
  let resolved: string
  try {
    resolved = await fs.promises.realpath(filePath)
  } catch {
    // File does not exist yet (e.g. file_write new file) — resolve parent directory
    const parentDir = path.dirname(path.resolve(filePath))
    try {
      const realParent = await fs.promises.realpath(parentDir)
      resolved = path.join(realParent, path.basename(filePath))
    } catch {
      resolved = path.resolve(filePath)
    }
  }
  const allBlocked = [...BLOCKED_PATH_PREFIXES, ...getSensitiveHomePaths()]
  for (const prefix of allBlocked) {
    const prefixWithoutSlash = prefix.replace(/\/$/, '')
    if (resolved === prefixWithoutSlash || resolved.startsWith(prefix)) {
      return `Access denied: ${prefix} paths are blocked`
    }
  }
  return null
}

async function resolveAndValidatePath(
  payload: { path?: unknown },
  defaultPath?: string,
): Promise<string | CommandResult> {
  const filePath = parseString(payload.path) ?? defaultPath ?? null
  if (!filePath) {
    return { success: false, error: 'No file path specified' }
  }
  const pathError = await validateFilePath(filePath)
  if (pathError) {
    return { success: false, error: pathError }
  }
  return filePath
}

export async function executeCommand(
  type: AgentCommandType,
  payload: Record<string, unknown>,
): Promise<CommandResult> {
  try {
    switch (type) {
      case 'execute_command':
        return await executeShellCommand(payload)
      case 'file_read':
        return await fileRead(payload)
      case 'file_write':
        return await fileWrite(payload)
      case 'file_list':
        return await fileList(payload)
      case 'process_list':
        return await processList()
      case 'process_kill':
        return await processKill(payload)
      default:
        return { success: false, error: `Unknown command type: ${type}` }
    }
  } catch (error) {
    const message = getErrorMessage(error)
    logger.error(`Command execution failed: ${message}`)
    return { success: false, error: message }
  }
}

async function executeShellCommand(
  payload: ShellCommandPayload,
): Promise<CommandResult> {
  const command = parseString(payload.command)
  if (!command) {
    return { success: false, error: 'No command specified' }
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

async function fileRead(
  payload: FileReadPayload,
): Promise<CommandResult> {
  const pathOrError = await resolveAndValidatePath(payload)
  if (typeof pathOrError !== 'string') return pathOrError
  const filePath = pathOrError

  const stat = await fs.promises.stat(filePath)
  if (stat.size > MAX_FILE_READ_SIZE) {
    return {
      success: false,
      error: `File too large: ${stat.size} bytes (limit: ${MAX_FILE_READ_SIZE} bytes)`,
    }
  }

  const content = await fs.promises.readFile(filePath, 'utf-8')
  return { success: true, data: content }
}

async function fileWrite(
  payload: FileWritePayload,
): Promise<CommandResult> {
  const pathOrError = await resolveAndValidatePath(payload)
  if (typeof pathOrError !== 'string') return pathOrError
  const filePath = pathOrError

  const content = typeof payload.content === 'string' ? payload.content : null
  if (content === null) {
    return { success: false, error: 'No content specified' }
  }
  if (content.length > MAX_FILE_WRITE_SIZE) {
    return { success: false, error: `Content too large: ${content.length} bytes (limit: ${MAX_FILE_WRITE_SIZE} bytes)` }
  }

  if (payload.createDirectories) {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  }

  await fs.promises.writeFile(filePath, content, 'utf-8')
  return { success: true, data: `Written to ${filePath}` }
}

async function fileList(
  payload: FileListPayload,
): Promise<CommandResult> {
  const pathOrError = await resolveAndValidatePath(payload, '.')
  if (typeof pathOrError !== 'string') return pathOrError
  const dirPath = pathOrError

  const allEntries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  const truncated = allEntries.length > MAX_DIR_ENTRIES
  const entries = allEntries.slice(0, MAX_DIR_ENTRIES)

  const items = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name)
      const type = entry.isDirectory() ? 'directory' : 'file'
      try {
        const stat = await fs.promises.lstat(fullPath)
        return { name: entry.name, type, size: stat.size, modified: stat.mtime.toISOString() }
      } catch {
        return { name: entry.name, type, size: 0, modified: '' }
      }
    }),
  )

  return { success: true, data: { items, truncated, total: allEntries.length } }
}

function processList(): Promise<CommandResult> {
  const command = os.platform() === 'win32'
    ? 'tasklist /fo csv /nh'
    : 'ps aux'

  return executeShellCommand({ command, timeout: PROCESS_LIST_TIMEOUT })
}

async function processKill(
  payload: ProcessKillPayload,
): Promise<CommandResult> {
  const pid = parseNumber(payload.pid)
  if (!pid || pid < 1 || !Number.isInteger(pid)) {
    return { success: false, error: 'Invalid PID: must be a positive integer' }
  }

  const signal = parseString(payload.signal) ?? 'SIGTERM'

  if (!ALLOWED_SIGNALS.has(signal)) {
    return { success: false, error: `Signal not allowed: ${signal}. Allowed: ${[...ALLOWED_SIGNALS].join(', ')}` }
  }

  try {
    process.kill(pid, signal)
    return { success: true, data: `Sent ${signal} to PID ${pid}` }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}
