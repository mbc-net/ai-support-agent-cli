import axios from 'axios'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { ApiClient } from '../../api-client'
import { guessContentType, isImageMime, isTextExtension, isTextMime } from '../../utils/content-type'
import { mcpImageResponse, mcpTextResponse, withMcpErrorHandling } from './mcp-response'

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
            timeout: 30000,
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
            timeout: 30000,
          })
          return mcpTextResponse(`File: ${filename}\n\n${response.data}`)
        }

        // For binary files (xlsx, pdf, docx, etc.), download to a temp file
        // and return the local path so Claude Code can process it with Bash tools
        const response = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 60000,
        })
        const fs = await import('fs')
        const path = await import('path')
        const os = await import('os')
        const tmpDir = path.join(os.tmpdir(), 'ai-support-agent-files')
        fs.mkdirSync(tmpDir, { recursive: true })
        const safeFilename = path.basename(filename)
        const tmpFilePath = path.join(tmpDir, safeFilename)
        fs.writeFileSync(tmpFilePath, Buffer.from(response.data as ArrayBuffer))

        return mcpTextResponse(
          `File "${filename}" (${contentType}) has been downloaded to: ${tmpFilePath}\n` +
            `You can read or process this file using Bash or Read tools.`,
        )
      }),
  )
}

