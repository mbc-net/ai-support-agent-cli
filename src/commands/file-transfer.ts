import axios from 'axios'
import { createWriteStream, readFileSync, mkdirSync, statSync, rmSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

import { ApiClient } from '../api-client'
import { logger } from '../logger'
import type { ChatFileInfo } from '../types'

export const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.log', '.html', '.css', '.js', '.ts', '.py', '.sh',
  '.sql', '.env', '.conf', '.cfg', '.ini', '.toml',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx',
  '.zip', '.tar', '.gz',
])

const CONTENT_TYPE_MAP: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.log': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.py': 'text/x-python',
  '.sh': 'text/x-shellscript',
  '.sql': 'application/sql',
  '.env': 'text/plain',
  '.conf': 'text/plain',
  '.cfg': 'text/plain',
  '.ini': 'text/plain',
  '.toml': 'application/toml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
}

export function getContentType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  return CONTENT_TYPE_MAP[ext] ?? 'application/octet-stream'
}

export interface DownloadResult {
  downloadedPaths: string[]
  failedCount: number
  cleanup: () => void
}

/**
 * S3 presigned URL 経由でファイルをダウンロードし、ローカルに保存する
 */
export async function downloadChatFiles(
  client: ApiClient,
  _agentId: string,
  files: ChatFileInfo[],
  projectDir: string,
  conversationId: string,
): Promise<DownloadResult> {
  const downloadDir = join(projectDir, '.chat-files', conversationId)
  mkdirSync(downloadDir, { recursive: true })

  const downloadedPaths: string[] = []
  let failedCount = 0

  for (const file of files) {
    try {
      const { downloadUrl } = await client.getDownloadUrl({
        fileId: file.fileId,
        s3Key: file.s3Key,
      })

      const filePath = join(downloadDir, file.filename)
      const response = await axios.get(downloadUrl, { responseType: 'stream' })
      const stream = response.data as Readable
      const writer = createWriteStream(filePath)
      await pipeline(stream, writer)

      downloadedPaths.push(filePath)
      logger.info(`[file-transfer] Downloaded file: ${file.filename} -> ${filePath}`)
    } catch (error) {
      failedCount++
      logger.error(`[file-transfer] Failed to download file ${file.filename}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const cleanup = () => {
    try {
      if (existsSync(downloadDir)) {
        rmSync(downloadDir, { recursive: true, force: true })
        logger.info(`[file-transfer] Cleaned up download directory: ${downloadDir}`)
      }
    } catch (error) {
      logger.warn(`[file-transfer] Failed to clean up download directory: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { downloadedPaths, failedCount, cleanup }
}

/**
 * ファイルを S3 presigned URL 経由でアップロードする
 */
export async function uploadFile(
  client: ApiClient,
  filePath: string,
  filename: string,
  conversationId: string,
  messageId: string,
  projectCode: string,
): Promise<{ fileId: string; s3Key: string }> {
  const ext = extname(filename).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File extension not allowed: ${ext}`)
  }

  const contentType = getContentType(filename)
  const fileBuffer = readFileSync(filePath)
  const fileSize = statSync(filePath).size

  const { uploadUrl, fileId, s3Key } = await client.getUploadUrl({
    conversationId,
    messageId,
    filename,
    contentType,
    fileSize,
    projectCode,
  })

  await axios.put(uploadUrl, fileBuffer, {
    headers: {
      'Content-Type': contentType,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  logger.info(`[file-transfer] Uploaded file: ${filename} (fileId: ${fileId})`)

  return { fileId, s3Key }
}

/**
 * ChatPayload の files フィールドをパースして ChatFileInfo[] を返す
 */
export function parseChatFiles(files: unknown): ChatFileInfo[] {
  if (!Array.isArray(files)) return []
  return files.filter(
    (item): item is ChatFileInfo =>
      typeof item === 'object' &&
      item !== null &&
      typeof item.fileId === 'string' &&
      typeof item.s3Key === 'string' &&
      typeof item.filename === 'string' &&
      typeof item.contentType === 'string' &&
      typeof item.fileSize === 'number',
  )
}
