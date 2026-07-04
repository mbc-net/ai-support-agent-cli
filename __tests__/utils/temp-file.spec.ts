import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { createSecureTempFile, safeUnlink } from '../../src/utils/temp-file'

jest.mock('../../src/logger')

import { logger } from '../../src/logger'

const mockLogger = jest.mocked(logger)

describe('temp-file utils', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('createSecureTempFile', () => {
    it('creates a file with the given content under the OS tmpdir and mode 0600', () => {
      const filepath = createSecureTempFile('secret-content', 'my-prefix')

      try {
        expect(filepath.startsWith(os.tmpdir())).toBe(true)
        expect(path.basename(filepath).startsWith('my-prefix-')).toBe(true)
        expect(fs.readFileSync(filepath, 'utf-8')).toBe('secret-content')
        // Mode check is skipped on Windows where POSIX permission bits don't apply
        if (process.platform !== 'win32') {
          const mode = fs.statSync(filepath).mode & 0o777
          expect(mode).toBe(0o600)
        }
      } finally {
        fs.unlinkSync(filepath)
      }
    })

    it('generates a unique filename on each call', () => {
      const a = createSecureTempFile('a', 'dup-prefix')
      const b = createSecureTempFile('b', 'dup-prefix')
      try {
        expect(a).not.toBe(b)
      } finally {
        fs.unlinkSync(a)
        fs.unlinkSync(b)
      }
    })
  })

  describe('safeUnlink', () => {
    it('deletes an existing file without logging a warning', () => {
      const filepath = createSecureTempFile('to-delete', 'safe-unlink')
      expect(fs.existsSync(filepath)).toBe(true)

      safeUnlink(filepath, 'should not be logged')

      expect(fs.existsSync(filepath)).toBe(false)
      expect(mockLogger.warn).not.toHaveBeenCalled()
    })

    it('logs the provided warning message instead of throwing when the file does not exist', () => {
      const missingPath = path.join(os.tmpdir(), `safe-unlink-missing-${Date.now()}`)
      expect(fs.existsSync(missingPath)).toBe(false)

      expect(() => safeUnlink(missingPath, `custom warning: ${missingPath}`)).not.toThrow()

      expect(mockLogger.warn).toHaveBeenCalledWith(`custom warning: ${missingPath}`)
    })
  })
})
