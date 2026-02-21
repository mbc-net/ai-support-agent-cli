import * as http from 'http'

import { startAuthServer } from '../src/auth-server'

function httpRequest(
  url: string,
  method: string,
  body?: string | Buffer,
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const headers: Record<string, string> = {}
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    const req = http.request(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method, headers },
      (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: data, headers: res.headers }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('auth-server', () => {
  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('should start server and return url, nonce, waitForCallback, stop', async () => {
    const result = await startAuthServer(0)
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(result.nonce).toHaveLength(64) // 32 bytes hex
    expect(typeof result.waitForCallback).toBe('function')
    expect(typeof result.stop).toBe('function')
    result.stop()
  })

  it('should respond 204 to OPTIONS (CORS preflight)', async () => {
    const { url, stop } = await startAuthServer(0)
    try {
      const res = await httpRequest(`${url}/callback`, 'OPTIONS')
      expect(res.statusCode).toBe(204)
    } finally {
      stop()
    }
  })

  it('should respond 200 and resolve waitForCallback on valid POST /callback', async () => {
    const { url, nonce, waitForCallback, stop } = await startAuthServer(0)
    try {
      const callbackPromise = waitForCallback()

      const res = await httpRequest(
        `${url}/callback`,
        'POST',
        JSON.stringify({ token: 'my-token', nonce, apiUrl: 'http://api', projectCode: 'proj' }),
      )
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body)).toEqual({ success: true })

      const authResult = await callbackPromise
      expect(authResult.token).toBe('my-token')
      expect(authResult.apiUrl).toBe('http://api')
      expect(authResult.projectCode).toBe('proj')
    } finally {
      stop()
    }
  })

  it('should respond 403 on invalid nonce', async () => {
    const { url, stop, waitForCallback: _wfc } = await startAuthServer(0)
    try {
      const res = await httpRequest(
        `${url}/callback`,
        'POST',
        JSON.stringify({ token: 'my-token', nonce: 'wrong-nonce' }),
      )
      expect(res.statusCode).toBe(403)
      expect(JSON.parse(res.body)).toEqual({ error: 'Invalid nonce' })
    } finally {
      stop()
    }
  })

  it('should respond 400 when token is missing', async () => {
    const { url, nonce, stop } = await startAuthServer(0)
    try {
      const res = await httpRequest(
        `${url}/callback`,
        'POST',
        JSON.stringify({ nonce, apiUrl: 'http://api' }),
      )
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'Missing token' })
    } finally {
      stop()
    }
  })

  it('should respond 400 on invalid JSON body', async () => {
    const { url, stop } = await startAuthServer(0)
    try {
      const res = await httpRequest(`${url}/callback`, 'POST', 'not json{{{')
      expect(res.statusCode).toBe(400)
      expect(JSON.parse(res.body)).toEqual({ error: 'Invalid request body' })
    } finally {
      stop()
    }
  })

  it('should respond 413 when body exceeds 64KB', async () => {
    const { url, stop } = await startAuthServer(0)
    try {
      const largeBody = Buffer.alloc(65 * 1024, 'a')
      const res = await httpRequest(`${url}/callback`, 'POST', largeBody)
      expect(res.statusCode).toBe(413)
    } finally {
      stop()
    }
  })

  it('should respond 404 for undefined routes', async () => {
    const { url, stop } = await startAuthServer(0)
    try {
      const res = await httpRequest(`${url}/unknown`, 'GET')
      expect(res.statusCode).toBe(404)
    } finally {
      stop()
    }
  })

  it('should reject waitForCallback on timeout', async () => {
    // Mock AUTH_TIMEOUT to a very short value
    jest.useFakeTimers()
    const { waitForCallback, stop } = await startAuthServer(0)

    const callbackPromise = waitForCallback()

    // Advance timer past AUTH_TIMEOUT
    jest.advanceTimersByTime(5 * 60 * 1000 + 1000)

    await expect(callbackPromise).rejects.toThrow()

    stop()
    jest.useRealTimers()
  })

  it('should close server on stop()', async () => {
    const { url, stop } = await startAuthServer(0)
    stop()

    // Server should be closed; a request should fail
    await expect(
      httpRequest(`${url}/callback`, 'POST', JSON.stringify({ token: 'x', nonce: 'y' })),
    ).rejects.toThrow()
  })

  it('should reject when server.address() returns null', async () => {
    const origListen = http.Server.prototype.listen
    let capturedServer: http.Server | undefined
    jest.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
      this: http.Server,
      ...args: unknown[]
    ) {
      capturedServer = this
      // Replace address() to return null
      this.address = () => null
      // Call original listen to trigger the callback
      return origListen.apply(this, args as Parameters<typeof origListen>)
    })

    await expect(startAuthServer(0)).rejects.toThrow('Failed to start auth server')

    if (capturedServer) (capturedServer as http.Server).close()
    jest.restoreAllMocks()
  })

  it('should set Access-Control-Allow-Origin to specified origin', async () => {
    const { url, stop } = await startAuthServer(0, 'https://example.com')
    try {
      const res = await httpRequest(`${url}/callback`, 'OPTIONS')
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('https://example.com')
    } finally {
      stop()
    }
  })

  it('should default Access-Control-Allow-Origin to http://127.0.0.1 when no origin specified', async () => {
    const { url, stop } = await startAuthServer(0)
    try {
      const res = await httpRequest(`${url}/callback`, 'OPTIONS')
      expect(res.statusCode).toBe(204)
      expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1')
    } finally {
      stop()
    }
  })

  it('should respond 400 on nonce replay (second POST with same nonce)', async () => {
    const { url, nonce, waitForCallback, stop } = await startAuthServer(0)
    try {
      const callbackPromise = waitForCallback()

      // First request should succeed
      const res1 = await httpRequest(
        `${url}/callback`,
        'POST',
        JSON.stringify({ token: 'my-token', nonce }),
      )
      expect(res1.statusCode).toBe(200)

      await callbackPromise

      // Second request with same nonce should be rejected
      const res2 = await httpRequest(
        `${url}/callback`,
        'POST',
        JSON.stringify({ token: 'another-token', nonce }),
      )
      expect(res2.statusCode).toBe(400)
      expect(JSON.parse(res2.body)).toEqual({ error: 'Nonce already used' })
    } finally {
      stop()
    }
  })

  it('should reject startAuthServer when server emits error before listening', async () => {
    // Start a server on a specific port, then try to start another on the same port
    const first = await startAuthServer(0)
    const parsed = new URL(first.url)
    const port = parseInt(parsed.port, 10)

    try {
      // Attempting to listen on an already-in-use port triggers server 'error' event
      await expect(startAuthServer(port)).rejects.toThrow()
    } finally {
      first.stop()
    }
  })
})
