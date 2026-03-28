import axios from 'axios'
import { createWriteStream, readFileSync, mkdirSync, statSync, rmSync, existsSync } from 'fs'
import { join, basename, extname } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

import { ApiClient } from '../api-client'
import { logger } from '../logger'
import type { ChatFileInfo } from '../types'
import { guessContentType } from '../utils/content-type'

export const ALLOWED_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml',
  '.log', '.html', '.css', '.js', '.ts', '.py', '.sh',
  '.sql', '.env', '.conf', '.cfg', '.ini', '.toml',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx',
  '.zip', '.tar', '.gz',
])

export function getContentType(filename: string): string {
  return guessContentType(filename)
}

export interface DownloadResult {
  downloadedPaths: string[]
  imagePaths: string[]
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
  const imagePaths: string[] = []
  let failedCount = 0

  for (const file of files) {
    try {
      const { downloadUrl } = await client.getDownloadUrl({
        fileId: file.fileId,
        s3Key: file.s3Key,
      })

      // Sanitize filename to prevent path traversal (e.g. "../../../etc/passwd")
      const safeName = basename(file.filename)
      const filePath = join(downloadDir, safeName)
      const response = await axios.get(downloadUrl, { responseType: 'stream' })
      const stream = response.data as Readable
      const writer = createWriteStream(filePath)
      await pipeline(stream, writer)

      if (file.contentType.startsWith('image/')) {
        imagePaths.push(filePath)
      } else {
        downloadedPaths.push(filePath)
      }
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

  return { downloadedPaths, imagePaths, failedCount, cleanup }
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
): Promise<{ fileId: string; s3Key: string; fileSize: number }> {
  const ext = extname(filename).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`File extension not allowed: ${ext}`)
  }

  const MAX_UPLOAD_SIZE = 100 * 1024 * 1024 // 100MB
  const fileSize = statSync(filePath).size
  if (fileSize > MAX_UPLOAD_SIZE) {
    throw new Error(`File too large: ${fileSize} bytes (max: ${MAX_UPLOAD_SIZE})`)
  }

  const contentType = getContentType(filename)
  const fileBuffer = readFileSync(filePath)

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

  return { fileId, s3Key, fileSize }
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

/**
 * ChatPayload の conversationFiles フィールドをパースして ChatFileInfo[] を返す
 * files と異なり contentType と fileSize は任意（デフォルト値で補完）
 */
export function parseConversationFiles(files: unknown): ChatFileInfo[] {
  if (!Array.isArray(files)) return []
  return files.filter(
    (f): f is ChatFileInfo =>
      f != null &&
      typeof f === 'object' &&
      typeof (f as Record<string, unknown>).fileId === 'string' &&
      typeof (f as Record<string, unknown>).s3Key === 'string' &&
      typeof (f as Record<string, unknown>).filename === 'string',
  )
}
