import axios from 'axios'
import { createWriteStream, mkdirSync, readFileSync, statSync } from 'fs'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

import type { ApiClient } from '../../src/api-client'
import {
  ALLOWED_EXTENSIONS,
  downloadChatFiles,
  getContentType,
  parseChatFiles,
  uploadFile,
} from '../../src/commands/file-transfer'
import type { ChatFileInfo } from '../../src/types'

jest.mock('axios')
jest.mock('fs', () => ({
  createWriteStream: jest.fn(),
  mkdirSync: jest.fn(),
  readFileSync: jest.fn(),
  statSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true),
  rmSync: jest.fn(),
}))
jest.mock('stream/promises', () => ({
  pipeline: jest.fn(),
}))
jest.mock('../../src/logger')

const mockedAxios = axios as jest.Mocked<typeof axios>
const mockedMkdirSync = mkdirSync as jest.MockedFunction<typeof mkdirSync>
const mockedCreateWriteStream = createWriteStream as jest.MockedFunction<typeof createWriteStream>
const mockedPipeline = pipeline as jest.MockedFunction<typeof pipeline>
const mockedReadFileSync = readFileSync as jest.MockedFunction<typeof readFileSync>
const mockedStatSync = statSync as jest.MockedFunction<typeof statSync>

describe('file-transfer', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('getContentType', () => {
    it('should return correct MIME type for known extensions', () => {
      expect(getContentType('document.txt')).toBe('text/plain')
      expect(getContentType('data.json')).toBe('application/json')
      expect(getContentType('image.png')).toBe('image/png')
      expect(getContentType('photo.jpg')).toBe('image/jpeg')
      expect(getContentType('style.css')).toBe('text/css')
      expect(getContentType('report.pdf')).toBe('application/pdf')
    })

    it('should return application/octet-stream for unknown extensions', () => {
      expect(getContentType('file.xyz')).toBe('application/octet-stream')
      expect(getContentType('noext')).toBe('application/octet-stream')
    })

    it('should handle case-insensitive extensions', () => {
      expect(getContentType('FILE.TXT')).toBe('text/plain')
      expect(getContentType('IMAGE.PNG')).toBe('image/png')
    })
  })

  describe('ALLOWED_EXTENSIONS', () => {
    it('should contain common text file extensions', () => {
      expect(ALLOWED_EXTENSIONS.has('.txt')).toBe(true)
      expect(ALLOWED_EXTENSIONS.has('.md')).toBe(true)
      expect(ALLOWED_EXTENSIONS.has('.json')).toBe(true)
      expect(ALLOWED_EXTENSIONS.has('.csv')).toBe(true)
    })

    it('should contain image extensions', () => {
      expect(ALLOWED_EXTENSIONS.has('.png')).toBe(true)
      expect(ALLOWED_EXTENSIONS.has('.jpg')).toBe(true)
      expect(ALLOWED_EXTENSIONS.has('.svg')).toBe(true)
    })

    it('should not contain executable extensions', () => {
      expect(ALLOWED_EXTENSIONS.has('.exe')).toBe(false)
      expect(ALLOWED_EXTENSIONS.has('.bat')).toBe(false)
      expect(ALLOWED_EXTENSIONS.has('.dll')).toBe(false)
    })
  })

  describe('parseChatFiles', () => {
    it('should parse valid ChatFileInfo array', () => {
      const files = [
        { fileId: 'f1', s3Key: 'key1', filename: 'test.txt', contentType: 'text/plain', fileSize: 100 },
        { fileId: 'f2', s3Key: 'key2', filename: 'img.png', contentType: 'image/png', fileSize: 200 },
      ]
      const result = parseChatFiles(files)
      expect(result).toHaveLength(2)
      expect(result[0].fileId).toBe('f1')
      expect(result[1].fileId).toBe('f2')
    })

    it('should return empty array for non-array input', () => {
      expect(parseChatFiles(null)).toEqual([])
      expect(parseChatFiles(undefined)).toEqual([])
      expect(parseChatFiles('string')).toEqual([])
      expect(parseChatFiles(42)).toEqual([])
    })

    it('should filter out invalid items', () => {
      const files = [
        { fileId: 'f1', s3Key: 'key1', filename: 'test.txt', contentType: 'text/plain', fileSize: 100 },
        { fileId: 'f2' }, // missing fields
        null,
        'string',
        { fileId: 'f3', s3Key: 'key3', filename: 'test.txt', contentType: 'text/plain', fileSize: 'not-a-number' },
      ]
      const result = parseChatFiles(files)
      expect(result).toHaveLength(1)
      expect(result[0].fileId).toBe('f1')
    })
  })

  describe('downloadChatFiles', () => {
    const mockClient = {
      getDownloadUrl: jest.fn(),
    } as unknown as ApiClient

    const files: ChatFileInfo[] = [
      { fileId: 'f1', s3Key: 'key1', filename: 'test.txt', contentType: 'text/plain', fileSize: 100 },
    ]

    it('should create directory and download file', async () => {
      (mockClient.getDownloadUrl as jest.Mock).mockResolvedValue({
        downloadUrl: 'https://s3.example.com/file',
      })

      const mockStream = new Readable({ read() { this.push(null) } })
      mockedAxios.get.mockResolvedValue({ data: mockStream })
      const mockWriter = {} as ReturnType<typeof createWriteStream>
      mockedCreateWriteStream.mockReturnValue(mockWriter)
      mockedPipeline.mockResolvedValue(undefined)

      const result = await downloadChatFiles(mockClient, 'agent-1', files, '/tmp/project', 'conv-1')

      expect(mockedMkdirSync).toHaveBeenCalledWith('/tmp/project/.chat-files/conv-1', { recursive: true })
      expect(mockClient.getDownloadUrl).toHaveBeenCalledWith({ fileId: 'f1', s3Key: 'key1' })
      expect(mockedAxios.get).toHaveBeenCalledWith('https://s3.example.com/file', { responseType: 'stream' })
      expect(mockedCreateWriteStream).toHaveBeenCalledWith('/tmp/project/.chat-files/conv-1/test.txt')
      expect(mockedPipeline).toHaveBeenCalledWith(mockStream, mockWriter)
      expect(result.downloadedPaths).toEqual(['/tmp/project/.chat-files/conv-1/test.txt'])
      expect(result.failedCount).toBe(0)
      expect(typeof result.cleanup).toBe('function')
    })

    it('should continue downloading other files when one fails', async () => {
      const twoFiles: ChatFileInfo[] = [
        { fileId: 'f1', s3Key: 'key1', filename: 'fail.txt', contentType: 'text/plain', fileSize: 100 },
        { fileId: 'f2', s3Key: 'key2', filename: 'success.txt', contentType: 'text/plain', fileSize: 200 },
      ]

      ;(mockClient.getDownloadUrl as jest.Mock)
        .mockRejectedValueOnce(new Error('Download failed'))
        .mockResolvedValueOnce({ downloadUrl: 'https://s3.example.com/file2' })

      const mockStream = new Readable({ read() { this.push(null) } })
      mockedAxios.get.mockResolvedValue({ data: mockStream })
      const mockWriter = {} as ReturnType<typeof createWriteStream>
      mockedCreateWriteStream.mockReturnValue(mockWriter)
      mockedPipeline.mockResolvedValue(undefined)

      const result = await downloadChatFiles(mockClient, 'agent-1', twoFiles, '/tmp/project', 'conv-1')

      expect(result.downloadedPaths).toEqual(['/tmp/project/.chat-files/conv-1/success.txt'])
      expect(result.failedCount).toBe(1)
    })

    it('should provide cleanup function that removes download directory', async () => {
      (mockClient.getDownloadUrl as jest.Mock).mockResolvedValue({
        downloadUrl: 'https://s3.example.com/file',
      })

      const mockStream = new Readable({ read() { this.push(null) } })
      mockedAxios.get.mockResolvedValue({ data: mockStream })
      const mockWriter = {} as ReturnType<typeof createWriteStream>
      mockedCreateWriteStream.mockReturnValue(mockWriter)
      mockedPipeline.mockResolvedValue(undefined)

      const { existsSync, rmSync } = require('fs')
      ;(existsSync as jest.Mock).mockReturnValue(true)

      const result = await downloadChatFiles(mockClient, 'agent-1', files, '/tmp/project', 'conv-1')
      result.cleanup()

      expect(existsSync).toHaveBeenCalledWith('/tmp/project/.chat-files/conv-1')
      expect(rmSync).toHaveBeenCalledWith('/tmp/project/.chat-files/conv-1', { recursive: true, force: true })
    })
  })

  describe('uploadFile', () => {
    const mockClient = {
      getUploadUrl: jest.fn(),
    } as unknown as ApiClient

    it('should upload file successfully', async () => {
      const fileBuffer = Buffer.from('file content')
      mockedReadFileSync.mockReturnValue(fileBuffer)
      mockedStatSync.mockReturnValue({ size: 12 } as ReturnType<typeof statSync>)

      ;(mockClient.getUploadUrl as jest.Mock).mockResolvedValue({
        uploadUrl: 'https://s3.example.com/upload',
        fileId: 'file-123',
        s3Key: 'uploads/file-123.txt',
      })

      mockedAxios.put.mockResolvedValue({ status: 200 })

      const result = await uploadFile(
        mockClient, '/tmp/test.txt', 'test.txt', 'conv-1', 'msg-1', 'TEST_01',
      )

      expect(result).toEqual({ fileId: 'file-123', s3Key: 'uploads/file-123.txt', fileSize: 12 })
      expect(mockClient.getUploadUrl).toHaveBeenCalledWith({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        filename: 'test.txt',
        contentType: 'text/plain',
        fileSize: 12,
        projectCode: 'TEST_01',
      })
      expect(mockedAxios.put).toHaveBeenCalledWith(
        'https://s3.example.com/upload',
        fileBuffer,
        expect.objectContaining({
          headers: { 'Content-Type': 'text/plain' },
        }),
      )
    })

    it('should reject files with disallowed extensions', async () => {
      await expect(
        uploadFile(mockClient, '/tmp/test.exe', 'test.exe', 'conv-1', 'msg-1', 'TEST_01'),
      ).rejects.toThrow('File extension not allowed: .exe')
    })
  })
})
