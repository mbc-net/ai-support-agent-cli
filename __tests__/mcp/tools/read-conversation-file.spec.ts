import axios from 'axios'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerReadConversationFileTool } from '../../../src/mcp/tools/read-conversation-file'
import {
  guessContentType,
  isTextExtension,
} from '../../../src/utils/content-type'

jest.mock('../../../src/api-client')
jest.mock('../../../src/logger')
jest.mock('axios')

const mockedAxios = axios as jest.Mocked<typeof axios>

describe('read-conversation-file tool', () => {
  let toolCallback: (args: {
    fileId: string
    s3Key: string
    filename: string
  }) => Promise<unknown>

  function setupTool(mockClient: Partial<ApiClient>) {
    const mockServer = {
      tool: jest.fn().mockImplementation(
        (_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
          toolCallback = cb
        },
      ),
    } as unknown as McpServer

    registerReadConversationFileTool(mockServer, mockClient as ApiClient)
  }

  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('registerReadConversationFileTool', () => {
    it('should register the tool on the server', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerReadConversationFileTool(mockServer, mockClient)

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'read_conversation_file',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })
  })

  describe('text file reading', () => {
    it('should download and return text file content', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockResolvedValue({
          downloadUrl: 'https://s3.example.com/file.txt',
        }),
      } as unknown as ApiClient

      setupTool(mockClient)

      mockedAxios.get.mockResolvedValue({ data: 'Hello, world!' })

      const result = await toolCallback({
        fileId: 'file-1',
        s3Key: 'uploads/file-1.txt',
        filename: 'readme.txt',
      }) as { content: Array<{ type: string; text: string }> }

      expect(mockClient.getDownloadUrl).toHaveBeenCalledWith({
        fileId: 'file-1',
        s3Key: 'uploads/file-1.txt',
      })
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://s3.example.com/file.txt',
        { responseType: 'text', timeout: 30000 },
      )
      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('File: readme.txt')
      expect(result.content[0].text).toContain('Hello, world!')
    })

    it('should handle text files with common extensions like .env', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockResolvedValue({
          downloadUrl: 'https://s3.example.com/env',
        }),
      } as unknown as ApiClient

      setupTool(mockClient)

      mockedAxios.get.mockResolvedValue({ data: 'KEY=value' })

      const result = await toolCallback({
        fileId: 'file-2',
        s3Key: 'uploads/file-2.env',
        filename: '.env',
      }) as { content: Array<{ type: string; text: string }> }

      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('KEY=value')
    })

    it('should handle JSON files', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockResolvedValue({
          downloadUrl: 'https://s3.example.com/data.json',
        }),
      } as unknown as ApiClient

      setupTool(mockClient)

      mockedAxios.get.mockResolvedValue({ data: '{"key": "value"}' })

      const result = await toolCallback({
        fileId: 'file-3',
        s3Key: 'uploads/file-3.json',
        filename: 'data.json',
      }) as { content: Array<{ type: string; text: string }> }

      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text).toContain('data.json')
      expect(result.content[0].text).toContain('{"key": "value"}')
    })
  })

  describe('image file reading', () => {
    it('should download and return image as base64', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockResolvedValue({
          downloadUrl: 'https://s3.example.com/image.png',
        }),
      } as unknown as ApiClient

      setupTool(mockClient)

      const imageBuffer = Buffer.from('fake-image-data')
      mockedAxios.get.mockResolvedValue({ data: imageBuffer })

      const result = await toolCallback({
        fileId: 'file-img',
        s3Key: 'uploads/file-img.png',
        filename: 'screenshot.png',
      }) as { content: Array<Record<string, string>> }

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://s3.example.com/image.png',
        { responseType: 'arraybuffer', timeout: 30000 },
      )
      expect(result.content[0].type).toBe('image')
      expect(result.content[0].data).toBe(imageBuffer.toString('base64'))
      expect(result.content[0].mimeType).toBe('image/png')
    })

    it('should handle JPEG images', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockResolvedValue({
          downloadUrl: 'https://s3.example.com/photo.jpg',
        }),
      } as unknown as ApiClient

      setupTool(mockClient)

      const imageBuffer = Buffer.from('fake-jpeg-data')
      mockedAxios.get.mockResolvedValue({ data: imageBuffer })

      const result = await toolCallback({
        fileId: 'file-jpg',
        s3Key: 'uploads/file-jpg.jpg',
        filename: 'photo.jpg',
      }) as { content: Array<Record<string, string>> }

      expect(result.content[0].type).toBe('image')
      expect(result.content[0].mimeType).toBe('image/jpeg')
    })
  })

  describe('binary file handling', () => {
    afterEach(() => {
      // Clean up temp files created during tests
      const tmpDir = path.join(os.tmpdir(), 'ai-support-agent-files')
      for (const name of ['document.pdf', 'archive.zip', 'data.xlsx']) {
        const tmpFile = path.join(tmpDir, name)
        if (fs.existsSync(tmpFile)) {
          fs.unlinkSync(tmpFile)
        }
      }
    })

    it('should download PDF to temp file and return path', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockResolvedValue({
          downloadUrl: 'https://s3.example.com/doc.pdf',
        }),
      } as unknown as ApiClient

      setupTool(mockClient)

      const pdfBuffer = Buffer.from('fake-pdf-data')
      mockedAxios.get.mockResolvedValue({ data: pdfBuffer })

      const result = await toolCallback({
        fileId: 'file-pdf',
        s3Key: 'uploads/file-pdf.pdf',
        filename: 'document.pdf',
      }) as { content: Array<{ text: string }>; isError?: boolean }

      expect(result.isError).toBeUndefined()
      expect(result.content[0].text).toContain('document.pdf')
      expect(result.content[0].text).toContain('downloaded to:')
      expect(result.content[0].text).toContain('Bash or Read tools')

      // Verify file was actually written
      const tmpDir = path.join(os.tmpdir(), 'ai-support-agent-files')
      const tmpFile = path.join(tmpDir, 'document.pdf')
      expect(fs.existsSync(tmpFile)).toBe(true)
      expect(fs.readFileSync(tmpFile)).toEqual(pdfBuffer)
    })

    it('should download xlsx to temp file and return path', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockResolvedValue({
          downloadUrl: 'https://s3.example.com/data.xlsx',
        }),
      } as unknown as ApiClient

      setupTool(mockClient)

      const xlsxBuffer = Buffer.from('fake-xlsx-data')
      mockedAxios.get.mockResolvedValue({ data: xlsxBuffer })

      const result = await toolCallback({
        fileId: 'file-xlsx',
        s3Key: 'uploads/file-xlsx.xlsx',
        filename: 'data.xlsx',
      }) as { content: Array<{ text: string }> }

      expect(result.content[0].text).toContain('data.xlsx')
      expect(result.content[0].text).toContain('downloaded to:')
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://s3.example.com/data.xlsx',
        { responseType: 'arraybuffer', timeout: 60000 },
      )
    })

    it('should download other binary files to temp file', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockResolvedValue({
          downloadUrl: 'https://s3.example.com/archive.zip',
        }),
      } as unknown as ApiClient

      setupTool(mockClient)

      const zipBuffer = Buffer.from('fake-zip-data')
      mockedAxios.get.mockResolvedValue({ data: zipBuffer })

      const result = await toolCallback({
        fileId: 'file-zip',
        s3Key: 'uploads/file-zip.zip',
        filename: 'archive.zip',
      }) as { content: Array<{ text: string }> }

      expect(result.content[0].text).toContain('archive.zip')
      expect(result.content[0].text).toContain('downloaded to:')
    })
  })

  describe('error handling', () => {
    it('should handle API errors', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockRejectedValue(new Error('API error')),
      } as unknown as ApiClient

      setupTool(mockClient)

      const result = await toolCallback({
        fileId: 'file-err',
        s3Key: 'uploads/file-err.txt',
        filename: 'error.txt',
      }) as { content: Array<{ text: string }>; isError: boolean }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('API error')
    })

    it('should handle download errors', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockResolvedValue({
          downloadUrl: 'https://s3.example.com/file.txt',
        }),
      } as unknown as ApiClient

      setupTool(mockClient)

      mockedAxios.get.mockRejectedValue(new Error('Network error'))

      const result = await toolCallback({
        fileId: 'file-net',
        s3Key: 'uploads/file-net.txt',
        filename: 'network.txt',
      }) as { content: Array<{ text: string }>; isError: boolean }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Network error')
    })

    it('should handle non-Error throws', async () => {
      const mockClient = {
        getDownloadUrl: jest.fn().mockRejectedValue('string error'),
      } as unknown as ApiClient

      setupTool(mockClient)

      const result = await toolCallback({
        fileId: 'file-str',
        s3Key: 'uploads/file-str.txt',
        filename: 'string.txt',
      }) as { content: Array<{ text: string }>; isError: boolean }

      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('string error')
    })
  })

  describe('guessContentType', () => {
    it('should return correct MIME types for known extensions', () => {
      expect(guessContentType('txt')).toBe('text/plain')
      expect(guessContentType('json')).toBe('application/json')
      expect(guessContentType('png')).toBe('image/png')
      expect(guessContentType('jpg')).toBe('image/jpeg')
      expect(guessContentType('pdf')).toBe('application/pdf')
      expect(guessContentType('ts')).toBe('application/typescript')
      expect(guessContentType('py')).toBe('text/x-python')
    })

    it('should return application/octet-stream for unknown extensions', () => {
      expect(guessContentType('xyz')).toBe('application/octet-stream')
      expect(guessContentType('')).toBe('application/octet-stream')
    })
  })

  describe('isTextExtension', () => {
    it('should return true for common text extensions', () => {
      expect(isTextExtension('txt')).toBe(true)
      expect(isTextExtension('json')).toBe(true)
      expect(isTextExtension('ts')).toBe(true)
      expect(isTextExtension('py')).toBe(true)
      expect(isTextExtension('env')).toBe(true)
      expect(isTextExtension('prisma')).toBe(true)
    })

    it('should return false for non-text extensions', () => {
      expect(isTextExtension('png')).toBe(false)
      expect(isTextExtension('pdf')).toBe(false)
      expect(isTextExtension('zip')).toBe(false)
      expect(isTextExtension('exe')).toBe(false)
    })
  })
})
