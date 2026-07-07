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

import {
  isCodexPluginDirValid,
  isPluginDirValid,
  prepareBundledCodexPluginProfile,
  resolveBundledPluginDir,
  resolveValidPluginDir,
} from '../../src/commands/plugin-dir'

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

  describe('isCodexPluginDirValid', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dir-test-'))
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('returns true when .codex-plugin/plugin.json exists under the given dir', () => {
      fs.mkdirSync(path.join(tmpDir, '.codex-plugin'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, '.codex-plugin', 'plugin.json'), '{}')

      expect(isCodexPluginDirValid(tmpDir)).toBe(true)
    })

    it('returns false when .codex-plugin/plugin.json is missing', () => {
      expect(isCodexPluginDirValid(tmpDir)).toBe(false)
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

  describe('prepareBundledCodexPluginProfile', () => {
    let pluginDir: string
    let codexHome: string
    let loggerWarnSpy: jest.Mock

    beforeEach(() => {
      pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dir-test-plugin-'))
      codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-dir-test-codex-home-'))
      const { logger } = require('../../src/logger')
      loggerWarnSpy = logger.warn as jest.Mock
      loggerWarnSpy.mockClear()
    })

    afterEach(() => {
      fs.rmSync(pluginDir, { recursive: true, force: true })
      fs.rmSync(codexHome, { recursive: true, force: true })
    })

    it('materializes a Codex marketplace and profile under CODEX_HOME', () => {
      fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true })
      fs.writeFileSync(path.join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify({
        name: 'ai-support-agent',
        version: '1.2.3',
      }))
      fs.mkdirSync(path.join(pluginDir, 'skills', 'sample'), { recursive: true })
      fs.writeFileSync(path.join(pluginDir, 'skills', 'sample', 'SKILL.md'), '---\nname: sample\ndescription: sample\n---\n')

      const result = prepareBundledCodexPluginProfile(pluginDir, codexHome)

      expect(result).toEqual({
        profileName: 'ai-support-agent-bundled',
        marketplaceName: 'ai-support-agent-bundled',
        pluginName: 'ai-support-agent',
        marketplaceRoot: path.join(codexHome, 'plugins', 'bundled-marketplaces', 'ai-support-agent-bundled'),
      })
      const marketplacePath = path.join(result!.marketplaceRoot, '.agents', 'plugins', 'marketplace.json')
      const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf-8'))
      expect(marketplace.name).toBe('ai-support-agent-bundled')
      expect(marketplace.plugins[0].source.path).toBe('./plugins/ai-support-agent')
      expect(fs.existsSync(path.join(result!.marketplaceRoot, 'plugins', 'ai-support-agent', '.codex-plugin', 'plugin.json'))).toBe(true)

      const profile = fs.readFileSync(path.join(codexHome, 'ai-support-agent-bundled.config.toml'), 'utf-8')
      expect(profile).toContain('[marketplaces.ai-support-agent-bundled]')
      expect(profile).toContain('[plugins."ai-support-agent@ai-support-agent-bundled"]')
      expect(profile).toContain('enabled = true')
      expect(loggerWarnSpy).not.toHaveBeenCalled()
    })

    it('returns null and warns when the Codex manifest is missing', () => {
      const result = prepareBundledCodexPluginProfile(pluginDir, codexHome)

      expect(result).toBeNull()
      expect(loggerWarnSpy).toHaveBeenCalledTimes(1)
    })
  })
})
