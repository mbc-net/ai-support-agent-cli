import http from 'http'

import { BrowserProxySession } from '../../../../src/mcp/tools/browser/browser-proxy-session'

jest.mock('../../../../src/logger')

describe('BrowserProxySession', () => {
  let mockServer: http.Server
  let port: number
  let lastRequest: { method: string; path: string; body: string }

  // Default response for all requests
  const defaultResponses: Record<string, Record<string, unknown>> = {
    'POST /browser/sess-1/navigate': { title: 'Test Page', url: 'https://example.com', screenshot: Buffer.from('screenshot').toString('base64') },
    'POST /browser/sess-1/click': { title: 'Clicked Page', url: 'https://example.com/clicked', screenshot: Buffer.from('screenshot').toString('base64') },
    'POST /browser/sess-1/fill': { ok: true },
    'POST /browser/sess-1/get-text': { text: 'Hello World' },
    'POST /browser/sess-1/screenshot': { screenshot: Buffer.from('screenshot').toString('base64') },
    'GET /browser/sess-1/url': { url: 'https://example.com' },
    'GET /browser/sess-1/title': { title: 'Test Page' },
    'POST /browser/sess-1/variable': { ok: true },
    'GET /browser/sess-1/variable/foo': { name: 'foo', value: 'bar' },
    'GET /browser/sess-1/variables': { variables: { foo: 'bar' } },
  }

  beforeAll(async () => {
    mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        const key = `${req.method} ${req.url}`
        lastRequest = { method: req.method ?? '', path: req.url ?? '', body }

        const response = defaultResponses[key]
        if (response) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(response))
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Not found' }))
        }
      })
    })

    mockServer.unref()
    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address()
        if (addr && typeof addr === 'object') {
          port = addr.port
        }
        resolve()
      })
    })
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => mockServer.close(() => resolve()))
  })

  beforeEach(() => {
    lastRequest = { method: '', path: '', body: '' }
  })

  it('should navigate and return screenshot buffer', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const result = await session.navigate('https://example.com')

    expect(result.title).toBe('Test Page')
    expect(result.url).toBe('https://example.com')
    expect(Buffer.isBuffer(result.screenshot)).toBe(true)
    expect(lastRequest.path).toBe('/browser/sess-1/navigate')
  })

  it('should navigate with options', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    await session.navigate('https://example.com', {
      waitForSelector: '.content',
      waitForTimeout: 1000,
      fullPage: false,
    })

    const body = JSON.parse(lastRequest.body)
    expect(body.waitForSelector).toBe('.content')
    expect(body.waitForTimeout).toBe(1000)
    expect(body.fullPage).toBe(false)
  })

  it('should click element', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const result = await session.click('#btn')

    expect(result.title).toBe('Clicked Page')
    expect(result.screenshot).toBeDefined()
    expect(lastRequest.path).toBe('/browser/sess-1/click')
  })

  it('should click without screenshot', async () => {
    // Add a response that has no screenshot
    defaultResponses['POST /browser/sess-1/click'] = { title: 'Clicked', url: 'https://example.com' }
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const result = await session.click('#btn', { screenshot: false })

    expect(result.screenshot).toBeUndefined()
    // Restore
    defaultResponses['POST /browser/sess-1/click'] = { title: 'Clicked Page', url: 'https://example.com/clicked', screenshot: Buffer.from('screenshot').toString('base64') }
  })

  it('should fill form field', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const result = await session.fill('#email', 'test@test.com')
    expect(result).toBeUndefined() // No screenshot returned
    expect(lastRequest.path).toBe('/browser/sess-1/fill')
  })

  it('should fill with screenshot', async () => {
    defaultResponses['POST /browser/sess-1/fill'] = { screenshot: Buffer.from('screenshot').toString('base64') }
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const result = await session.fill('#email', 'test@test.com', true)
    expect(Buffer.isBuffer(result)).toBe(true)
    defaultResponses['POST /browser/sess-1/fill'] = { ok: true }
  })

  it('should get text', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const text = await session.getText('.content')
    expect(text).toBe('Hello World')
  })

  it('should take screenshot', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const buffer = await session.screenshot()
    expect(Buffer.isBuffer(buffer)).toBe(true)
  })

  it('should get url', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const url = await session.getUrl()
    expect(url).toBe('https://example.com')
  })

  it('should get title', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const title = await session.getTitle()
    expect(title).toBe('Test Page')
  })

  it('should set and get variables', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')

    await session.setVariable('foo', 'bar')
    expect(lastRequest.path).toBe('/browser/sess-1/variable')

    const value = await session.getVariable('foo')
    expect(value).toBe('bar')
  })

  it('should return undefined for missing variable', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const value = await session.getVariable('missing')
    expect(value).toBeUndefined()
  })

  it('should list variables', async () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    const vars = await session.listVariables()
    expect(vars).toEqual({ foo: 'bar' })
  })

  it('should always report as active', () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    expect(session.isActive()).toBe(true)
  })

  it('should have a working actionLog', () => {
    const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
    session.actionLog.add('chat', 'navigate', 'https://example.com')
    expect(session.actionLog.size).toBe(1)
  })

  describe('variables Map interface', () => {
    it('should support get/set/entries on variables', () => {
      const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
      session.variables.set('key1', 'val1')
      expect(session.variables.get('key1')).toBe('val1')

      const entries = Array.from(session.variables.entries())
      expect(entries).toEqual([['key1', 'val1']])
    })
  })

  describe('variables refresh', () => {
    it('should refresh cache from server', async () => {
      const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'sess-1')
      await session.variables.refresh()
      expect(session.variables.get('foo')).toBe('bar')
    })
  })

  describe('error handling', () => {
    it('should throw on connection refused', async () => {
      // Use a port that is not listening
      const session = new BrowserProxySession('http://127.0.0.1:1', 'sess-1')
      await expect(session.navigate('https://example.com')).rejects.toThrow()
    })

    it('should throw on HTTP error response', async () => {
      // Use a non-existent session to get a 404
      const session = new BrowserProxySession(`http://127.0.0.1:${port}`, 'unknown-sess')
      await expect(session.navigate('https://example.com')).rejects.toThrow('Not found')
    })

    it('should throw on invalid JSON response', async () => {
      // Create a server that returns invalid JSON
      const badServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('not-json')
      })
      badServer.unref()
      const badPort = await new Promise<number>((resolve) => {
        badServer.listen(0, '127.0.0.1', () => {
          const addr = badServer.address()
          resolve((addr as { port: number }).port)
        })
      })

      try {
        const session = new BrowserProxySession(`http://127.0.0.1:${badPort}`, 'sess-1')
        await expect(session.getUrl()).rejects.toThrow('Invalid JSON')
      } finally {
        await new Promise<void>((resolve) => badServer.close(() => resolve()))
      }
    })
  })
})
