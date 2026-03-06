import * as fs from 'fs'
import * as path from 'path'

import { ERR_NO_CONTENT_SPECIFIED, ERR_NO_FILE_PATH_SPECIFIED, MAX_DIR_ENTRIES, MAX_FILE_READ_SIZE, MAX_FILE_WRITE_SIZE } from '../constants'
import { resolveAndValidatePath } from '../security'
import type { CommandResult, FileDeletePayload, FileListPayload, FileMkdirPayload, FileReadPayload, FileRenamePayload, FileWritePayload } from '../types'
import { parseString } from '../utils'

import { withValidatedPath } from './file-path-guard'

export async function fileRead(
  payload: FileReadPayload,
): Promise<CommandResult> {
  return withValidatedPath(payload, async (filePath) => {
    const stat = await fs.promises.stat(filePath)
    if (stat.size > MAX_FILE_READ_SIZE) {
      return {
        success: false,
        error: `File too large: ${stat.size} bytes (limit: ${MAX_FILE_READ_SIZE} bytes)`,
      }
    }

    const content = await fs.promises.readFile(filePath, 'utf-8')
    return { success: true, data: content }
  })
}

export async function fileWrite(
  payload: FileWritePayload,
): Promise<CommandResult> {
  return withValidatedPath(payload, async (filePath) => {
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
  })
}

export async function fileList(
  payload: FileListPayload,
): Promise<CommandResult> {
  return withValidatedPath(payload, async (dirPath) => {
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
  }, '.')
}

export async function fileRename(
  payload: FileRenamePayload,
): Promise<CommandResult> {
  const oldPath = parseString(payload.oldPath)
  const newPath = parseString(payload.newPath)
  if (!oldPath || !newPath) {
    return { success: false, error: ERR_NO_FILE_PATH_SPECIFIED }
  }

  const oldPathOrError = await resolveAndValidatePath({ path: oldPath })
  if (typeof oldPathOrError !== 'string') return oldPathOrError
  const newPathOrError = await resolveAndValidatePath({ path: newPath })
  if (typeof newPathOrError !== 'string') return newPathOrError

  await fs.promises.rename(oldPathOrError, newPathOrError)
  return { success: true, data: `Renamed ${oldPathOrError} to ${newPathOrError}` }
}

export async function fileDelete(
  payload: FileDeletePayload,
): Promise<CommandResult> {
  return withValidatedPath(payload, async (resolvedPath) => {
    if (payload.recursive) {
      await fs.promises.rm(resolvedPath, { recursive: true, force: true })
    } else {
      const stat = await fs.promises.lstat(resolvedPath)
      if (stat.isDirectory()) {
        await fs.promises.rmdir(resolvedPath)
      } else {
        await fs.promises.unlink(resolvedPath)
      }
    }
    return { success: true, data: `Deleted ${resolvedPath}` }
  })
}

export async function fileMkdir(
  payload: FileMkdirPayload,
): Promise<CommandResult> {
  return withValidatedPath(payload, async (resolvedPath) => {
    await fs.promises.mkdir(resolvedPath, { recursive: true })
    return { success: true, data: `Created directory ${resolvedPath}` }
  })
}
