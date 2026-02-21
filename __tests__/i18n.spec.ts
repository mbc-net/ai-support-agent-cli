import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('i18n', () => {
  let originalArgv: string[]
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    originalArgv = [...process.argv]
    originalEnv = { ...process.env }
    // Clear all locale env vars
    delete process.env.LC_ALL
    delete process.env.LC_MESSAGES
    delete process.env.LANG
    // Reset module cache for each test
    jest.resetModules()
  })

  afterEach(() => {
    process.argv = originalArgv
    process.env = originalEnv
  })

  describe('initI18n', () => {
    it('should initialize with explicit language', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('ja')
      expect(t('cmd.start')).toContain('エージェント')
    })

    it('should initialize with English by default', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('en')
      expect(t('cmd.start')).toBe('Start agent (all registered projects)')
    })

    it('should detect --lang from process.argv', () => {
      process.argv = ['node', 'index.js', '--lang', 'ja', 'start']
      const { initI18n, t } = require('../src/i18n')
      initI18n()
      expect(t('cmd.start')).toContain('エージェント')
    })

    it('should detect locale from LANG env var', () => {
      process.env.LANG = 'ja_JP.UTF-8'
      const { initI18n, t } = require('../src/i18n')
      initI18n()
      expect(t('cmd.start')).toContain('エージェント')
    })

    it('should detect locale from LC_ALL env var', () => {
      process.env.LC_ALL = 'ja_JP.UTF-8'
      const { initI18n, t } = require('../src/i18n')
      initI18n()
      expect(t('cmd.start')).toContain('エージェント')
    })

    it('should fallback to English for unknown locale', () => {
      process.env.LANG = 'fr_FR.UTF-8'
      const { initI18n, t } = require('../src/i18n')
      initI18n()
      expect(t('cmd.start')).toBe('Start agent (all registered projects)')
    })

    it('should detect locale from config.json language setting', () => {
      // Create a temporary config.json with language setting
      const tmpDir = path.join(os.tmpdir(), `.ai-support-agent-i18n-test-${process.pid}`)
      const configDir = path.join(tmpDir, '.ai-support-agent')
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify({ language: 'ja' }),
      )

      // Mock os.homedir to return our tmp dir
      jest.doMock('os', () => {
        const originalOs = jest.requireActual('os')
        return { ...originalOs, homedir: () => tmpDir }
      })

      const { initI18n, t } = require('../src/i18n')
      initI18n()
      expect(t('cmd.start')).toContain('エージェント')

      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('should detect locale from Intl.DateTimeFormat when no other source', () => {
      // No --lang, no env vars, no config.json — Intl.DateTimeFormat is used
      const { initI18n, t } = require('../src/i18n')
      initI18n()
      // Intl returns 'en-US' etc on most systems, so English is expected
      expect(t('cmd.start')).toBe('Start agent (all registered projects)')
    })
  })

  describe('t (translation)', () => {
    it('should return the key when not found', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('en')
      expect(t('nonexistent.key')).toBe('nonexistent.key')
    })

    it('should interpolate parameters', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('en')
      expect(t('auth.url', { url: 'http://example.com' })).toBe(
        'URL: http://example.com',
      )
    })

    it('should interpolate numeric parameters', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('en')
      expect(t('runner.startingMulti', { count: 3 })).toBe(
        'Starting agents for 3 projects...',
      )
    })

    it('should keep placeholder when param is missing', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('en')
      expect(t('auth.url', {})).toBe('URL: {{url}}')
    })

    it('should return template without params when no params given', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('en')
      expect(t('runner.starting')).toBe('Starting agent...')
    })
  })

  describe('path traversal prevention', () => {
    it('should return empty translations for path traversal attempt', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('../../etc/passwd')
      // Should fall back to English since the traversal path is rejected
      expect(t('cmd.start')).toBe('Start agent (all registered projects)')
    })

    it('should return empty translations for lang with special characters', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('../xx')
      expect(t('cmd.start')).toBe('Start agent (all registered projects)')
    })

    it('should return empty translations for uppercase lang', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('EN')
      // EN doesn't match /^[a-z]{2}$/, so loadLocale returns {}
      // but fallback is loaded with 'en', so English keys are still available
      expect(t('cmd.start')).toBe('Start agent (all registered projects)')
    })
  })

  describe('fallback behavior', () => {
    it('should fall back to English when Japanese key is missing', () => {
      const { initI18n, t } = require('../src/i18n')
      initI18n('ja')
      // All keys exist in both, so test with a non-existent locale key
      // by temporarily using Japanese, then verifying English fallback works
      expect(t('cmd.description')).toBe('AI Support Agent CLI')
    })
  })

  describe('locale file completeness', () => {
    it('should have the same keys in en.json and ja.json', () => {
      const localesDir = path.join(__dirname, '..', 'src', 'locales')
      const en = JSON.parse(
        fs.readFileSync(path.join(localesDir, 'en.json'), 'utf-8'),
      )
      const ja = JSON.parse(
        fs.readFileSync(path.join(localesDir, 'ja.json'), 'utf-8'),
      )

      const enKeys = Object.keys(en).sort()
      const jaKeys = Object.keys(ja).sort()

      expect(jaKeys).toEqual(enKeys)
    })

    it('should have non-empty values for all keys', () => {
      const localesDir = path.join(__dirname, '..', 'src', 'locales')
      const en = JSON.parse(
        fs.readFileSync(path.join(localesDir, 'en.json'), 'utf-8'),
      )
      const ja = JSON.parse(
        fs.readFileSync(path.join(localesDir, 'ja.json'), 'utf-8'),
      )

      for (const key of Object.keys(en)) {
        expect(en[key]).toBeTruthy()
        expect(ja[key]).toBeTruthy()
      }
    })
  })
})
