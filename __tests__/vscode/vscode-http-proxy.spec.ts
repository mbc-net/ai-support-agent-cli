import * as http from 'http'
import { EventEmitter } from 'events'

import { proxyHttpRequest } from '../../src/vscode/vscode-http-proxy'

jest.mock('http', () => ({
  request: jest.fn(),
}))

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}))

describe('proxyHttpRequest', () => {
  let mockReq: EventEmitter & { write: jest.Mock; end: jest.Mock; destroy: jest.Mock; setTimeout: jest.Mock }

  beforeEach(() => {
    jest.clearAllMocks()
    mockReq = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      end: jest.fn(),
      destroy: jest.fn(),
      setTimeout: jest.fn(),
    })
  })

  it('should proxy a GET request and return response', async () => {
    const mockRes = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'content-type': 'text/html' },
    })

    ;(http.request as jest.Mock).mockImplementation((_opts: http.RequestOptions, cb: (res: typeof mockRes) => void) => {
      process.nextTick(() => {
        cb(mockRes)
        mockRes.emit('data', Buffer.from('hello'))
        mockRes.emit('end')
      })
      return mockReq
    })

    const result = await proxyHttpRequest(8443, {
      method: 'GET',
      path: '/healthz',
      headers: {},
    })

    expect(result.statusCode).toBe(200)
    expect(result.headers['content-type']).toBe('text/html')
    expect(Buffer.from(result.body, 'base64').toString()).toBe('hello')
    expect(mockReq.end).toHaveBeenCalled()
  })

  it('should send request body when provided', async () => {
    const mockRes = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
    })

    ;(http.request as jest.Mock).mockImplementation((_opts: http.RequestOptions, cb: (res: typeof mockRes) => void) => {
      process.nextTick(() => {
        cb(mockRes)
        mockRes.emit('end')
      })
      return mockReq
    })

    const bodyBase64 = Buffer.from('test body').toString('base64')
    await proxyHttpRequest(8443, {
      method: 'POST',
      path: '/api',
      headers: { 'content-type': 'application/json' },
      body: bodyBase64,
    })

    expect(mockReq.write).toHaveBeenCalledWith(Buffer.from(bodyBase64, 'base64'))
  })

  it('should reject on request error', async () => {
    ;(http.request as jest.Mock).mockImplementation(() => {
      process.nextTick(() => {
        mockReq.emit('error', new Error('ECONNREFUSED'))
      })
      return mockReq
    })

    await expect(
      proxyHttpRequest(8443, { method: 'GET', path: '/', headers: {} }),
    ).rejects.toThrow('ECONNREFUSED')
  })

  it('should reject on timeout', async () => {
    ;(http.request as jest.Mock).mockImplementation(() => {
      return mockReq
    })

    // Capture the timeout callback
    mockReq.setTimeout.mockImplementation((_ms: number, cb: () => void) => {
      process.nextTick(cb)
    })

    await expect(
      proxyHttpRequest(8443, { method: 'GET', path: '/', headers: {} }),
    ).rejects.toThrow('Proxy request timeout')

    expect(mockReq.destroy).toHaveBeenCalled()
  })

  it('should handle array header values', async () => {
    const mockRes = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: { 'set-cookie': ['a=1', 'b=2'] },
    })

    ;(http.request as jest.Mock).mockImplementation((_opts: http.RequestOptions, cb: (res: typeof mockRes) => void) => {
      process.nextTick(() => {
        cb(mockRes)
        mockRes.emit('end')
      })
      return mockReq
    })

    const result = await proxyHttpRequest(8443, {
      method: 'GET',
      path: '/',
      headers: {},
    })

    expect(result.headers['set-cookie']).toBe('a=1, b=2')
  })

  it('should default to status 500 if statusCode is undefined', async () => {
    const mockRes = Object.assign(new EventEmitter(), {
      statusCode: undefined,
      headers: {},
    })

    ;(http.request as jest.Mock).mockImplementation((_opts: http.RequestOptions, cb: (res: typeof mockRes) => void) => {
      process.nextTick(() => {
        cb(mockRes)
        mockRes.emit('end')
      })
      return mockReq
    })

    const result = await proxyHttpRequest(8443, {
      method: 'GET',
      path: '/',
      headers: {},
    })

    expect(result.statusCode).toBe(500)
  })
})
