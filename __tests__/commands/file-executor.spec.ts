import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { fileList, fileRead, fileWrite } from '../../src/commands/file-executor'
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
})
