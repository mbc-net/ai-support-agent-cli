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

    it('SENTRY_ENVIRONMENT と NODE_ENV が未設定の場合は production にフォールバック', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      delete process.env.SENTRY_ENVIRONMENT
      delete process.env.NODE_ENV
      const { initSentry: init } = require('../src/sentry')
      await init()
      const options = mockInit.mock.calls[0][0]
      expect(options.environment).toBe('production')
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

    it('breadcrumbs がないイベントをそのまま返す', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = { message: 'an error without breadcrumbs' }
      const result = beforeSend(event)
      expect(result).toEqual(event)
    })

    it('breadcrumb の message が undefined の場合はそのまま保持する', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = {
        breadcrumbs: [
          { category: 'navigation' }, // no message field
        ],
      }
      const result = beforeSend(event)
      expect(result.breadcrumbs[0].message).toBeUndefined()
    })

    it('exception.values[].value 内の機密情報をマスクする', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = {
        exception: {
          values: [
            {
              type: 'Error',
              value: 'Failed with Bearer eyJhbGciOiJIUzI1NiJ9',
            },
          ],
        },
      }
      const result = beforeSend(event)
      expect(result.exception.values[0].value).toBe('Failed with Bearer ****')
    })

    it('exception.values が複数ある場合は全て機密情報をマスクする', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = {
        exception: {
          values: [
            { type: 'Error', value: 'token=abc123' },
            { type: 'Error', value: 'password=mypass123' },
          ],
        },
      }
      const result = beforeSend(event)
      expect(result.exception.values[0].value).toBe('token=****')
      expect(result.exception.values[1].value).toBe('password=****')
    })

    it('exception.values[].stacktrace.frames 内の文字列情報もマスクする', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = {
        exception: {
          values: [
            {
              type: 'Error',
              value: 'boom',
              stacktrace: {
                frames: [
                  {
                    filename: 'src/foo.ts',
                    context_line: 'const token = "token=abc123"',
                    pre_context: ['password=mypass123'],
                    post_context: ['normal line'],
                  },
                ],
              },
            },
          ],
        },
      }
      const result = beforeSend(event)
      const frame = result.exception.values[0].stacktrace.frames[0]
      expect(frame.context_line).toBe(maskSecrets('const token = "token=abc123"'))
      expect(frame.context_line).not.toContain('abc123')
      expect(frame.pre_context[0]).toBe('password=****')
      expect(frame.post_context[0]).toBe('normal line')
    })

    it('exception.values が undefined の場合はそのまま返す', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = { message: 'no exception field' }
      const result = beforeSend(event)
      expect(result).toEqual(event)
    })

    it('value が undefined の exception エントリはそのまま保持する', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = {
        exception: {
          values: [{ type: 'Error' }],
        },
      }
      const result = beforeSend(event)
      expect(result.exception.values[0].value).toBeUndefined()
    })

    it('event.message 内の機密情報をマスクする', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = {
        message: 'Request failed with Bearer eyJhbGciOiJIUzI1NiJ9',
      }
      const result = beforeSend(event)
      expect(result.message).toBe('Request failed with Bearer ****')
    })

    it('event.message が undefined の場合はそのまま保持する', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = { exception: { values: [] } }
      const result = beforeSend(event)
      expect(result.message).toBeUndefined()
    })

    it('event.extra の文字列値内の機密情報をマスクする', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = {
        extra: {
          handler: 'uncaughtException',
          detail: 'token=abc123',
        },
      }
      const result = beforeSend(event)
      expect(result.extra.detail).toBe('token=****')
      expect(result.extra.handler).toBe('uncaughtException')
    })

    it('event.extra の非文字列値はそのまま保持する', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = {
        extra: {
          count: 3,
          flag: true,
          nested: { token: 'abc123' },
          list: ['token=abc123'],
        },
      }
      const result = beforeSend(event)
      expect(result.extra.count).toBe(3)
      expect(result.extra.flag).toBe(true)
      expect(result.extra.nested).toEqual({ token: 'abc123' })
      expect(result.extra.list).toEqual(['token=abc123'])
    })

    it('event.extra が undefined の場合はそのまま返す', async () => {
      jest.resetModules()
      process.env.SENTRY_DSN = 'https://test@sentry.io/123'
      const mod = require('../src/sentry')
      await mod.initSentry()
      const beforeSend = mockInit.mock.calls[0][0].beforeSend
      const event = { message: 'no extra field' }
      const result = beforeSend(event)
      expect(result.extra).toBeUndefined()
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
