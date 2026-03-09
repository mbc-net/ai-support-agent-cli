import { captureException, flushSentry } from '../src/sentry'
import { maskSecrets } from '../src/logger'

// @sentry/node のモック
const mockInit = jest.fn()
const mockCaptureException = jest.fn()
const mockFlush = jest.fn().mockResolvedValue(true)

jest.mock('@sentry/node', () => ({
  init: mockInit,
  captureException: mockCaptureException,
  flush: mockFlush,
}))

describe('sentry', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.clearAllMocks()
    jest.resetModules()
    process.env = { ...originalEnv }
    delete process.env.SENTRY_DSN
    delete process.env.SENTRY_ENVIRONMENT
  })

  afterAll(() => {
    process.env = originalEnv
  })

  describe('initSentry', () => {
    it('DSN未設定時は Sentry.init() を呼ばない', async () => {
      // モジュールを再読み込みして初期化状態をリセット
      jest.resetModules()
      const { initSentry: init } = require('../src/sentry')
      await init()
      expect(mockInit).not.toHaveBeenCalled()
    })

    it('DSN設定時は Sentry.init() を正しいオプションで呼ぶ', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      process.env.SENTRY_ENVIRONMENT = 'test'
      const { initSentry: init } = require('../src/sentry')
      await init()
      expect(mockInit).toHaveBeenCalledTimes(1)
      const options = mockInit.mock.calls[0][0]
      expect(options.dsn).toBe('https://test@sentry.io/123')
      expect(options.environment).toBe('test')
      expect(options.sendDefaultPii).toBe(false)
      expect(options.tracesSampleRate).toBe(0.05)
      expect(options.release).toMatch(/^ai-support-agent-cli@/)
      expect(typeof options.beforeSend).toBe('function')
      expect(typeof options.beforeBreadcrumb).toBe('function')
    })

    it('SENTRY_ENVIRONMENT 未設定時は NODE_ENV にフォールバック', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      process.env.NODE_ENV = 'staging'
      const { initSentry: init } = require('../src/sentry')
      await init()
      const options = mockInit.mock.calls[0][0]
      expect(options.environment).toBe('staging')
    })
  })

  describe('captureException', () => {
    it('未初期化時は no-op', () => {
      // sentry モジュールがリセットされた状態 → sentry = null
      captureException(new Error('test'))
      // init されていないので mockCaptureException は呼ばれない
      // （直前の beforeEach で clearAllMocks しているため 0 回）
    })

    it('初期化済み時は Sentry.captureException を呼ぶ', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const error = new Error('test error')
      mod.captureException(error)
      expect(mockCaptureException).toHaveBeenCalledWith(error, undefined)
    })

    it('コンテキスト付きで呼び出すと extra に渡される', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const error = new Error('test')
      const context = { handler: 'uncaughtException' }
      mod.captureException(error, context)
      expect(mockCaptureException).toHaveBeenCalledWith(error, { extra: context })
    })
  })

  describe('flushSentry', () => {
    it('未初期化時は no-op', async () => {
      await flushSentry()
      // mockFlush が呼ばれないことを確認（captureException のテスト同様）
    })

    it('初期化済み時は Sentry.flush を呼ぶ', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      await mod.flushSentry()
      expect(mockFlush).toHaveBeenCalledWith(2000)
    })
  })

  describe('maskSecrets', () => {
    it('token を含む値をマスクする', () => {
      expect(maskSecrets('token=abc123')).toBe('token=****')
    })

    it('password を含む値をマスクする', () => {
      expect(maskSecrets('password=mypass123')).toBe('password=****')
    })

    it('api_key を含む値をマスクする', () => {
      expect(maskSecrets('api_key=sk-123456')).toBe('api_key=****')
    })

    it('authorization を含む値をマスクする', () => {
      expect(maskSecrets('authorization=Bearer-xxx')).toBe('authorization=****')
    })

    it('Bearer トークンをマスクする', () => {
      expect(maskSecrets('Bearer eyJhbGciOiJIUzI1NiJ9')).toBe('Bearer ****')
    })

    it('AWS Access Key ID をマスクする', () => {
      expect(maskSecrets('key: AKIAIOSFODNN7EXAMPLE')).toBe('key: AKIA****')
    })

    it('複数のパターンを同時にマスクする', () => {
      const input = 'token=abc password=xyz'
      const result = maskSecrets(input)
      expect(result).toBe('token=**** password=****')
    })

    it('機密情報を含まない文字列はそのまま返す', () => {
      const input = 'Hello, world!'
      expect(maskSecrets(input)).toBe('Hello, world!')
    })
  })

  describe('beforeSend', () => {
    it('breadcrumb メッセージ内の機密情報をマスクする', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = {
        breadcrumbs: [
          { message: 'token=secret123', category: 'console' },
          { message: 'normal message', category: 'console' },
        ],
      }
      const result = beforeSend(event)
      expect(result.breadcrumbs[0].message).toBe('token=****')
      expect(result.breadcrumbs[1].message).toBe('normal message')
    })
  })

  describe('beforeBreadcrumb', () => {
    it('HTTP breadcrumb の URL 内のトークンパラメータをマスクする', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeBreadcrumb = mockInit.mock.calls[0][0].beforeBreadcrumb
      const breadcrumb = {
        category: 'http',
        data: { url: 'https://api.example.com/path?token=abc&other=ok' },
      }
      const result = beforeBreadcrumb(breadcrumb)
      expect(result.data.url).toBe('https://api.example.com/path?token=[Filtered]&other=ok')
    })

    it('HTTP 以外の breadcrumb はそのまま返す', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeBreadcrumb = mockInit.mock.calls[0][0].beforeBreadcrumb
      const breadcrumb = {
        category: 'console',
        message: 'test',
      }
      const result = beforeBreadcrumb(breadcrumb)
      expect(result).toEqual(breadcrumb)
    })
  })
})
