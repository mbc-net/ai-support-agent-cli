/**
 * Tests for src/commands/plugin-dir.ts
 *
 * Covers resolution of the bundled Claude Code plugin directory and the
 * warn-and-skip behavior when the plugin is missing from the build output.
 *
 * Uses real temporary directories (matching the convention used elsewhere in
 * this repo, e.g. terminal-session.spec.ts) rather than jest.spyOn(fs, ...):
 * spying directly on built-in fs sync methods triggers
 * "TypeError: Cannot redefine property" under this repo's Node/Jest/ts-jest
 * combination.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { resolveBundledPluginDir, isPluginDirValid, resolveValidPluginDir } from '../../src/commands/plugin-dir'

jest.mock('../../src/logger')

describe('plugin-dir', () => {
  describe('resolveBundledPluginDir', () => {
    it('resolves to a "plugin" directory adjacent to the commands directory', () => {
      const result = resolveBundledPluginDir()
      expect(path.basename(result)).toBe('plugin')
    })

    it('returns an absolute path', () => {
      const result = resolveBundledPluginDir()
      expect(path.isAbsolute(result)).toBe(true)
    })
  })

  describe('isPluginDirValid', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dir-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns true when .claude-plugin/plugin.json exists under the given dir', () => {
      fs.mkdirSync(path.join(tmpDir, '.claude-plugin'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, '.claude-plugin', 'plugin.json'), '{}')

      expect(isPluginDirValid(tmpDir)).toBe(true)
    })

    it('returns false when .claude-plugin/plugin.json is missing', () => {
      expect(isPluginDirValid(tmpDir)).toBe(false)
    })

    it('returns false when the directory itself does not exist', () => {
      expect(isPluginDirValid(path.join(tmpDir, 'does-not-exist'))).toBe(false)
    })
  })

  describe('resolveValidPluginDir', () => {
    let tmpDir: string
    let loggerWarnSpy: jest.Mock

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dir-test-'))
      const { logger } = require('../../src/logger')
      loggerWarnSpy = logger.warn as jest.Mock
      loggerWarnSpy.mockClear()
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns the given dir and does not warn when it is a valid plugin dir', () => {
      fs.mkdirSync(path.join(tmpDir, '.claude-plugin'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, '.claude-plugin', 'plugin.json'), '{}')

      const result = resolveValidPluginDir(tmpDir)

      expect(result).toBe(tmpDir)
      expect(loggerWarnSpy).not.toHaveBeenCalled()
    })

    it('returns null and logs a warning when the given dir is not a valid plugin dir', () => {
      const result = resolveValidPluginDir(tmpDir)

      expect(result).toBeNull()
      expect(loggerWarnSpy).toHaveBeenCalledTimes(1)
      expect(String(loggerWarnSpy.mock.calls[0][0])).toContain(tmpDir)
    })

    it('defaults to resolveBundledPluginDir() when no dir is given', () => {
      const dir = resolveBundledPluginDir()
      const result = resolveValidPluginDir()

      if (isPluginDirValid(dir)) {
        expect(result).toBe(dir)
      } else {
        expect(result).toBeNull()
      }
    })
  })
})
