import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import axios from 'axios'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { CONVERSATION_BINARY_DOWNLOAD_TIMEOUT_MS, CONVERSATION_FILE_DOWNLOAD_TIMEOUT_MS } from '../../constants'
import { guessContentType, isImageMime, isTextExtension, isTextMime } from '../../utils/content-type'
import { mcpImageResponse, mcpTextResponse, withMcpErrorHandling } from './mcp-response'

/** 一時ファイルの権限（所有者のみ読み書き） */
const TEMP_FILE_MODE = 0o600

/** 一時ディレクトリの権限（所有者のみアクセス可） */
const TEMP_DIR_MODE = 0o700

export function registerReadConversationFileTool(
  server: McpServer,
  apiClient: ApiClient,
): void {
  server.tool(
    'read_conversation_file',
    'Read a file that was shared in the conversation. Use this to access previously uploaded files.',
    {
      fileId: z.string().describe('File ID from the conversation_files list'),
      s3Key: z.string().describe('S3 key from the conversation_files list'),
      filename: z.string().describe('Original filename for display'),
    },
    async ({ fileId, s3Key, filename }) =>
      withMcpErrorHandling(async () => {
        // Get presigned download URL from API
        const { downloadUrl } = await apiClient.getDownloadUrl({
          fileId,
          s3Key,
        })

        // Determine content type from filename extension
        const ext = filename.split('.').pop()?.toLowerCase() ?? ''
        const contentType = guessContentType(ext) // ext without dot

        if (isImageMime(contentType)) {
          // For images, download as buffer and return base64
          const response = await axios.get(downloadUrl, {
            responseType: 'arraybuffer',
            timeout: CONVERSATION_FILE_DOWNLOAD_TIMEOUT_MS,
          })
          const base64 = Buffer.from(response.data as ArrayBuffer).toString(
            'base64',
          )
          return mcpImageResponse(base64, contentType)
        }

        if (isTextMime(contentType) || isTextExtension(ext)) {
          // For text files, download as UTF-8 string
          const response = await axios.get(downloadUrl, {
            responseType: 'text',
            timeout: CONVERSATION_FILE_DOWNLOAD_TIMEOUT_MS,
          })
          return mcpTextResponse(`File: ${filename}\n\n${response.data}`)
        }

        // For binary files (xlsx, pdf, docx, etc.), download to a temp file
        // and return the local path so Claude Code can process it with Bash tools
        const response = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: CONVERSATION_BINARY_DOWNLOAD_TIMEOUT_MS,
        })
        // 会話添付は業務データ（証明書・鍵・顧客情報等）を含み得るため、共有 /tmp 上でも
        // 所有者のみアクセス可の権限で作る（既定の umask では 0755/0644）。
        // project-files.ts と同一方針。
        const tmpDir = path.join(os.tmpdir(), 'ai-support-agent-files')
        fs.mkdirSync(tmpDir, { recursive: true, mode: TEMP_DIR_MODE })
        // 既存ディレクトリには mkdirSync の mode が効かないため明示的に設定する。
        fs.chmodSync(tmpDir, TEMP_DIR_MODE)
        const safeFilename = path.basename(filename)
        const uniqueId = crypto.randomUUID().slice(0, 8)
        const tmpFilePath = path.join(tmpDir, `${uniqueId}_${safeFilename}`)
        fs.writeFileSync(tmpFilePath, Buffer.from(response.data as ArrayBuffer), {
          mode: TEMP_FILE_MODE,
        })

        return mcpTextResponse(
          `File "${filename}" (${contentType}) has been downloaded to: ${tmpFilePath}\n` +
            `You can read or process this file using Bash or Read tools.`,
        )
      }),
  )
}

