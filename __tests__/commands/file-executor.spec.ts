import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { fileDelete, fileList, fileMkdir, fileRead, fileRename, fileWrite } from '../../src/commands/file-executor'
import { ERR_NO_CONTENT_SPECIFIED, ERR_NO_FILE_PATH_SPECIFIED } from '../../src/constants'
import type { CommandResult } from '../../src/types'

function expectFailure(result: CommandResult): asserts result is { success: false; error: string; data?: unknown } {
  expect(result.success).toBe(false)
}

describe('file-executor', () => {
  describe('fileRead', () => {
    it('should read a file', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-fread-${Date.now()}.txt`)
      fs.writeFileSync(tmpFile, 'test content')

      const result = await fileRead({ path: tmpFile })
      expect(result.success).toBe(true)
      expect(result.data).toBe('test content')

      fs.unlinkSync(tmpFile)
    })

    it('should return error for missing path', async () => {
      const result = await fileRead({})
      expectFailure(result)
      expect(result.error).toBe(ERR_NO_FILE_PATH_SPECIFIED)
    })

    it('should block reading /etc/shadow', async () => {
      const result = await fileRead({ path: '/etc/shadow' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })
  })

  describe('fileWrite', () => {
    it('should write a file', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-fwrite-${Date.now()}.txt`)

      const result = await fileWrite({ path: tmpFile, content: 'written content' })
      expect(result.success).toBe(true)
      expect(fs.readFileSync(tmpFile, 'utf-8')).toBe('written content')

      fs.unlinkSync(tmpFile)
    })

    it('should block writing to /etc/ paths', async () => {
      const result = await fileWrite({ path: '/etc/malicious', content: 'bad' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should return error when no content specified', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-nocontent-${Date.now()}.txt`)

      const result = await fileWrite({ path: tmpFile })
      expectFailure(result)
      expect(result.error).toBe(ERR_NO_CONTENT_SPECIFIED)
    })
  })

  describe('fileList', () => {
    it('should list directory contents', async () => {
      const result = await fileList({ path: os.tmpdir() })
      expect(result.success).toBe(true)
      const data = result.data as { items: unknown[]; truncated: boolean; total: number }
      expect(Array.isArray(data.items)).toBe(true)
      expect(typeof data.truncated).toBe('boolean')
      expect(typeof data.total).toBe('number')
    })

    it('should block listing /proc/', async () => {
      const result = await fileList({ path: '/proc/' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })
  })

  describe('fileRename', () => {
    it('should rename a file', async () => {
      const oldFile = path.join(os.tmpdir(), `test-rename-old-${Date.now()}.txt`)
      const newFile = path.join(os.tmpdir(), `test-rename-new-${Date.now()}.txt`)
      fs.writeFileSync(oldFile, 'rename me')

      const result = await fileRename({ oldPath: oldFile, newPath: newFile })
      expect(result.success).toBe(true)
      expect(fs.existsSync(oldFile)).toBe(false)
      expect(fs.readFileSync(newFile, 'utf-8')).toBe('rename me')

      fs.unlinkSync(newFile)
    })

    it('should return error when oldPath is missing', async () => {
      const result = await fileRename({ newPath: '/tmp/something' })
      expectFailure(result)
      expect(result.error).toBe(ERR_NO_FILE_PATH_SPECIFIED)
    })

    it('should return error when newPath is missing', async () => {
      const result = await fileRename({ oldPath: '/tmp/something' })
      expectFailure(result)
      expect(result.error).toBe(ERR_NO_FILE_PATH_SPECIFIED)
    })

    it('should block renaming to /etc/ paths', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-rename-blocked-${Date.now()}.txt`)
      fs.writeFileSync(tmpFile, 'data')

      const result = await fileRename({ oldPath: tmpFile, newPath: '/etc/malicious' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')

      fs.unlinkSync(tmpFile)
    })

    it('should throw when source does not exist', async () => {
      await expect(
        fileRename({
          oldPath: path.join(os.tmpdir(), `nonexistent-${Date.now()}.txt`),
          newPath: path.join(os.tmpdir(), `target-${Date.now()}.txt`),
        }),
      ).rejects.toThrow()
    })
  })

  describe('fileDelete', () => {
    it('should delete a file', async () => {
      const tmpFile = path.join(os.tmpdir(), `test-delete-${Date.now()}.txt`)
      fs.writeFileSync(tmpFile, 'delete me')

      const result = await fileDelete({ path: tmpFile })
      expect(result.success).toBe(true)
      expect(fs.existsSync(tmpFile)).toBe(false)
    })

    it('should delete an empty directory', async () => {
      const tmpDir = path.join(os.tmpdir(), `test-delete-dir-${Date.now()}`)
      fs.mkdirSync(tmpDir)

      const result = await fileDelete({ path: tmpDir })
      expect(result.success).toBe(true)
      expect(fs.existsSync(tmpDir)).toBe(false)
    })

    it('should delete a directory recursively', async () => {
      const tmpDir = path.join(os.tmpdir(), `test-delete-recursive-${Date.now()}`)
      fs.mkdirSync(tmpDir)
      fs.writeFileSync(path.join(tmpDir, 'child.txt'), 'child')

      const result = await fileDelete({ path: tmpDir, recursive: true })
      expect(result.success).toBe(true)
      expect(fs.existsSync(tmpDir)).toBe(false)
    })

    it('should return error for missing path', async () => {
      const result = await fileDelete({})
      expectFailure(result)
      expect(result.error).toBe(ERR_NO_FILE_PATH_SPECIFIED)
    })

    it('should block deleting /etc/ paths', async () => {
      const result = await fileDelete({ path: '/etc/passwd' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })

    it('should throw when path does not exist', async () => {
      await expect(
        fileDelete({ path: path.join(os.tmpdir(), `nonexistent-${Date.now()}.txt`) }),
      ).rejects.toThrow()
    })
  })

  describe('fileMkdir', () => {
    it('should create a directory', async () => {
      const tmpDir = path.join(os.tmpdir(), `test-mkdir-${Date.now()}`)

      const result = await fileMkdir({ path: tmpDir })
      expect(result.success).toBe(true)
      expect(fs.statSync(tmpDir).isDirectory()).toBe(true)

      fs.rmdirSync(tmpDir)
    })

    it('should create nested directories', async () => {
      const baseName = `test-mkdir-nested-${Date.now()}`
      const baseDir = path.join(os.tmpdir(), baseName)
      const tmpDir = path.join(baseDir, 'a', 'b')

      const result = await fileMkdir({ path: tmpDir })
      expect(result.success).toBe(true)
      expect(fs.statSync(tmpDir).isDirectory()).toBe(true)

      fs.rmSync(baseDir, { recursive: true })
    })

    it('should return error for missing path', async () => {
      const result = await fileMkdir({})
      expectFailure(result)
      expect(result.error).toBe(ERR_NO_FILE_PATH_SPECIFIED)
    })

    it('should block creating directories in /etc/', async () => {
      const result = await fileMkdir({ path: '/etc/malicious-dir' })
      expectFailure(result)
      expect(result.error).toContain('Access denied')
    })
  })
})
