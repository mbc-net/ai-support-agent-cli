import * as fs from 'fs'
import * as path from 'path'

import { ERR_NO_CONTENT_SPECIFIED, MAX_DIR_ENTRIES, MAX_FILE_READ_SIZE, MAX_FILE_WRITE_SIZE } from '../constants'
import { resolveAndValidatePath } from '../security'
import type { CommandResult, FileListPayload, FileReadPayload, FileWritePayload } from '../types'

export async function fileRead(
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

export async function fileWrite(
  payload: FileWritePayload,
): Promise<CommandResult> {
  const pathOrError = await resolveAndValidatePath(payload)
  if (typeof pathOrError !== 'string') return pathOrError
  const filePath = pathOrError

  const content = typeof payload.content === 'string' ? payload.content : null
  if (content === null) {
    return { success: false, error: ERR_NO_CONTENT_SPECIFIED }
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

export async function fileList(
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
