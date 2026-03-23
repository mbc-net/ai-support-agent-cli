import http from 'http'

import { BrowserLocalServer } from '../../src/browser/browser-local-server'
import { BrowserSessionManager } from '../../src/mcp/tools/browser/browser-session-manager'

jest.mock('../../src/logger')
jest.mock('../../src/mcp/tools/browser/browser-security', () => ({
  validateUrl: jest.fn().mockReturnValue({ valid: true }),
}))

function httpRequest(port: number, method: string, path: string, body?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        resolve({ status: res.statusCode ?? 0, body: data })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

describe('BrowserLocalServer', () => {
  let server: BrowserLocalServer
  let manager: BrowserSessionManager
  let port: number

  const mockPage = {
    goto: jest.fn().mockResolvedValue(undefined),
    title: jest.fn().mockResolvedValue('Test Page'),
    url: jest.fn().mockReturnValue('https://example.com'),
    waitForSelector: jest.fn().mockResolvedValue(undefined),
    waitForTimeout: jest.fn().mockResolvedValue(undefined),
    waitForNavigation: jest.fn().mockResolvedValue(undefined),
    click: jest.fn().mockResolvedValue(undefined),
    fill: jest.fn().mockResolvedValue(undefined),
    locator: jest.fn().mockReturnValue({
      innerText: jest.fn().mockResolvedValue('Hello World'),
    }),
    goBack: jest.fn().mockResolvedValue(undefined),
    goForward: jest.fn().mockResolvedValue(undefined),
    reload: jest.fn().mockResolvedValue(undefined),
  }

  const mockSession = {
    getPage: jest.fn().mockResolvedValue(mockPage),
    screenshot: jest.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
    getCurrentUrl: jest.fn().mockReturnValue('https://example.com'),
    getPageTitle: jest.fn().mockResolvedValue('Test Page'),
    variables: new Map<string, string>(),
    actionLog: { add: jest.fn() },
    isActive: jest.fn().mockReturnValue(true),
  }

  beforeAll(async () => {
    manager = new BrowserSessionManager()
    // Mock the get method to return our mock session
    jest.spyOn(manager, 'get').mockReturnValue(mockSession as never)
    server = new BrowserLocalServer(manager)
    port = await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(manager, 'get').mockReturnValue(mockSession as never)
    mockSession.variables.clear()
  })

  it('should start on a random port', () => {
    expect(port).toBeGreaterThan(0)
    expect(server.getPort()).toBe(port)
  })

  it('should return 404 for invalid routes', async () => {
    const res = await httpRequest(port, 'GET', '/')
    expect(res.status).toBe(404)
  })

  it('should return 404 for unknown session', async () => {
    jest.spyOn(manager, 'get').mockReturnValue(undefined)
    const res = await httpRequest(port, 'POST', '/browser/unknown-session/navigate', JSON.stringify({ url: 'https://example.com' }))
    expect(res.status).toBe(404)
    expect(res.body.error).toContain('Session not found')
  })

  describe('navigate', () => {
    it('should navigate and return screenshot', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/navigate', JSON.stringify({ url: 'https://example.com' }))
      expect(res.status).toBe(200)
      expect(res.body.title).toBe('Test Page')
      expect(res.body.url).toBe('https://example.com')
      expect(res.body.screenshot).toBeDefined()
    })

    it('should return 400 for missing url', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/navigate', JSON.stringify({}))
      expect(res.status).toBe(400)
    })

    it('should return 400 for invalid url', async () => {
      const { validateUrl } = require('../../src/mcp/tools/browser/browser-security')
      ;(validateUrl as jest.Mock).mockReturnValueOnce({ valid: false, reason: 'Blocked protocol' })

      const res = await httpRequest(port, 'POST', '/browser/sess-1/navigate', JSON.stringify({ url: 'file:///etc/passwd' }))
      expect(res.status).toBe(400)
      expect(res.body.error).toContain('Blocked protocol')
    })

    it('should add action log entry', async () => {
      await httpRequest(port, 'POST', '/browser/sess-1/navigate', JSON.stringify({ url: 'https://example.com' }))
      expect(mockSession.actionLog.add).toHaveBeenCalledWith('chat', 'navigate', 'https://example.com')
    })
  })

  describe('click', () => {
    it('should click element and return screenshot', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/click', JSON.stringify({ selector: '#btn' }))
      expect(res.status).toBe(200)
      expect(res.body.title).toBe('Test Page')
      expect(mockPage.click).toHaveBeenCalledWith('#btn', { timeout: 10000 })
    })

    it('should return 400 for missing selector', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/click', JSON.stringify({}))
      expect(res.status).toBe(400)
    })

    it('should add action log entry', async () => {
      await httpRequest(port, 'POST', '/browser/sess-1/click', JSON.stringify({ selector: '#btn' }))
      expect(mockSession.actionLog.add).toHaveBeenCalledWith('chat', 'click', '#btn')
    })
  })

  describe('fill', () => {
    it('should fill form field', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/fill', JSON.stringify({ selector: '#email', value: 'test@test.com' }))
      expect(res.status).toBe(200)
      expect(mockPage.fill).toHaveBeenCalledWith('#email', 'test@test.com', { timeout: 10000 })
    })

    it('should return 400 for missing selector or value', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/fill', JSON.stringify({ selector: '#email' }))
      expect(res.status).toBe(400)
    })

    it('should return screenshot when requested', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/fill', JSON.stringify({ selector: '#email', value: 'test@test.com', screenshot: true }))
      expect(res.status).toBe(200)
      expect(res.body.screenshot).toBeDefined()
    })
  })

  describe('get-text', () => {
    it('should return text content', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/get-text', JSON.stringify({}))
      expect(res.status).toBe(200)
      expect(res.body.text).toBe('Hello World')
    })
  })

  describe('screenshot', () => {
    it('should return screenshot', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/screenshot', JSON.stringify({}))
      expect(res.status).toBe(200)
      expect(res.body.screenshot).toBeDefined()
    })
  })

  describe('url', () => {
    it('should return current url', async () => {
      const res = await httpRequest(port, 'GET', '/browser/sess-1/url')
      expect(res.status).toBe(200)
      expect(res.body.url).toBe('https://example.com')
    })
  })

  describe('title', () => {
    it('should return page title', async () => {
      const res = await httpRequest(port, 'GET', '/browser/sess-1/title')
      expect(res.status).toBe(200)
      expect(res.body.title).toBe('Test Page')
    })
  })

  describe('variables', () => {
    it('should set and get variables', async () => {
      const setRes = await httpRequest(port, 'POST', '/browser/sess-1/variable', JSON.stringify({ name: 'foo', value: 'bar' }))
      expect(setRes.status).toBe(200)

      const getRes = await httpRequest(port, 'GET', '/browser/sess-1/variable/foo')
      expect(getRes.status).toBe(200)
      expect(getRes.body.value).toBe('bar')
    })

    it('should return 404 for unknown variable', async () => {
      const res = await httpRequest(port, 'GET', '/browser/sess-1/variable/unknown')
      expect(res.status).toBe(404)
    })

    it('should return 400 for missing variable name or value', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/variable', JSON.stringify({ name: 'foo' }))
      expect(res.status).toBe(400)
    })

    it('should list all variables', async () => {
      mockSession.variables.set('a', '1')
      mockSession.variables.set('b', '2')
      const res = await httpRequest(port, 'GET', '/browser/sess-1/variables')
      expect(res.status).toBe(200)
      expect(res.body.variables).toEqual({ a: '1', b: '2' })
    })
  })

  describe('unknown action', () => {
    it('should return 404', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/unknown-action', JSON.stringify({}))
      expect(res.status).toBe(404)
    })
  })

  describe('click with waitForNavigation', () => {
    it('should wait for navigation if specified', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/click', JSON.stringify({ selector: '#btn', waitForNavigation: true }))
      expect(res.status).toBe(200)
      expect(mockPage.waitForNavigation).toHaveBeenCalled()
    })

    it('should skip screenshot if disabled', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/click', JSON.stringify({ selector: '#btn', screenshot: false }))
      expect(res.status).toBe(200)
      expect(res.body.screenshot).toBeUndefined()
    })
  })

  describe('navigate with waitForSelector and waitForTimeout', () => {
    it('should handle waitForSelector', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/navigate', JSON.stringify({
        url: 'https://example.com',
        waitForSelector: '.content',
      }))
      expect(res.status).toBe(200)
      expect(mockPage.waitForSelector).toHaveBeenCalledWith('.content', { timeout: 10000 })
    })

    it('should handle waitForTimeout', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/navigate', JSON.stringify({
        url: 'https://example.com',
        waitForTimeout: 5000,
      }))
      expect(res.status).toBe(200)
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(5000)
    })

    it('should clamp waitForTimeout to 10000', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/navigate', JSON.stringify({
        url: 'https://example.com',
        waitForTimeout: 20000,
      }))
      expect(res.status).toBe(200)
      expect(mockPage.waitForTimeout).toHaveBeenCalledWith(10000)
    })
  })

  describe('variable with GET missing name', () => {
    it('should return 400 when GET variable without name', async () => {
      const res = await httpRequest(port, 'GET', '/browser/sess-1/variable')
      expect(res.status).toBe(400)
    })
  })

  describe('error handling', () => {
    it('should return 500 on internal error', async () => {
      mockSession.getPage.mockRejectedValueOnce(new Error('Internal error'))
      const res = await httpRequest(port, 'POST', '/browser/sess-1/navigate', JSON.stringify({ url: 'https://example.com' }))
      expect(res.status).toBe(500)
    })

    it('should handle invalid JSON body', async () => {
      const res = await httpRequest(port, 'POST', '/browser/sess-1/navigate', 'invalid json')
      expect(res.status).toBe(500)
    })
  })

  describe('stop', () => {
    it('should be idempotent when already stopped', async () => {
      const tempServer = new BrowserLocalServer(manager)
      // Should not throw when called on non-started server
      await tempServer.stop()
    })
  })
})
