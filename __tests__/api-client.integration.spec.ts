import * as http from 'http'

import { ApiClient } from '../src/api-client'
import { API_ENDPOINTS } from '../src/constants'

// No jest.mock('axios') — tests use real axios over real HTTP

interface CapturedRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: string
}

let server: http.Server
let baseUrl: string
let lastReq: CapturedRequest

/** Configurable response for the test server */
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} }

/** Track how many requests the server received (for retry tests) */
let requestCount: number

beforeAll((done) => {
  requestCount = 0
  server = http.createServer((req, res) => {
    requestCount++
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      lastReq = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      }
      res.writeHead(nextResponse.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(nextResponse.body))
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      baseUrl = `http://127.0.0.1:${addr.port}`
    }
    done()
  })
})

afterAll((done) => {
  server.close(done)
})

beforeEach(() => {
  nextResponse = { status: 200, body: {} }
  requestCount = 0
})

describe('ApiClient integration (real axios + real HTTP)', () => {
  const TEST_TOKEN = 'test-token-abc'

  it('should send a real HTTP POST when register() is called', async () => {
    const registerResponse = { agentId: 'agent-1', appsyncUrl: 'wss://test', appsyncApiKey: 'key' }
    nextResponse = { status: 200, body: registerResponse }

    const client = new ApiClient(baseUrl, TEST_TOKEN)
    const result = await client.register({
      agentId: 'agent-1',
      hostname: 'test-host',
      os: 'linux',
      arch: 'x64',
    })

    expect(lastReq.method).toBe('POST')
    expect(lastReq.url).toBe(API_ENDPOINTS.REGISTER)
    expect(result).toEqual(registerResponse)
  })

  it('should send Authorization header as Bearer <token>', async () => {
    nextResponse = { status: 200, body: { agentId: 'a', appsyncUrl: '', appsyncApiKey: '' } }

    const client = new ApiClient(baseUrl, TEST_TOKEN)
    await client.register({ agentId: 'a', hostname: 'h', os: 'o', arch: 'a' })

    expect(lastReq.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`)
  })

  it('should send Content-Type as application/json', async () => {
    nextResponse = { status: 200, body: { agentId: 'a', appsyncUrl: '', appsyncApiKey: '' } }

    const client = new ApiClient(baseUrl, TEST_TOKEN)
    await client.register({ agentId: 'a', hostname: 'h', os: 'o', arch: 'a' })

    expect(lastReq.headers['content-type']).toMatch(/application\/json/)
  })

  it('should unwrap { data } from register() response correctly', async () => {
    const expected = { agentId: 'agent-99', appsyncUrl: 'wss://x', appsyncApiKey: 'key-99' }
    nextResponse = { status: 200, body: expected }

    const client = new ApiClient(baseUrl, TEST_TOKEN)
    const result = await client.register({ agentId: 'agent-99', hostname: 'h', os: 'o', arch: 'a' })

    // axios wraps the HTTP body in { data }, ApiClient returns data directly
    expect(result).toEqual(expected)
    expect(result.agentId).toBe('agent-99')
  })

  it('should send GET to the correct path for getPendingCommands()', async () => {
    nextResponse = { status: 200, body: [{ commandId: 'c1', type: 'execute_command', createdAt: 1 }] }

    const client = new ApiClient(baseUrl, TEST_TOKEN)
    const commands = await client.getPendingCommands()

    expect(lastReq.method).toBe('GET')
    expect(lastReq.url).toBe(API_ENDPOINTS.COMMANDS_PENDING)
    expect(commands).toHaveLength(1)
    expect(commands[0].commandId).toBe('c1')
  })

  it('should send POST with correct body for submitResult()', async () => {
    nextResponse = { status: 200, body: {} }

    const client = new ApiClient(baseUrl, TEST_TOKEN)
    await client.submitResult('cmd-123', { success: true, data: { output: 'hello' } })

    expect(lastReq.method).toBe('POST')
    expect(lastReq.url).toBe(API_ENDPOINTS.COMMAND_RESULT('cmd-123'))
    const body = JSON.parse(lastReq.body)
    expect(body).toEqual({ success: true, data: { output: 'hello' } })
  })

  it('should retry on server 500 errors', async () => {
    let callCount = 0
    const origHandler = server.listeners('request')[0] as (...args: unknown[]) => void
    server.removeAllListeners('request')
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      callCount++
      let body = ''
      req.on('data', (chunk: string) => (body += chunk))
      req.on('end', () => {
        lastReq = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
        if (callCount <= 2) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Internal Server Error' }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify([]))
        }
      })
    })

    try {
      const client = new ApiClient(baseUrl, TEST_TOKEN)
      const result = await client.getPendingCommands()
      expect(result).toEqual([])
      expect(callCount).toBe(3) // 2 failures + 1 success
    } finally {
      server.removeAllListeners('request')
      server.on('request', origHandler)
    }
  }, 30000)

  it('should not retry on 400 client errors', async () => {
    let callCount = 0
    const origHandler = server.listeners('request')[0] as (...args: unknown[]) => void
    server.removeAllListeners('request')
    server.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
      callCount++
      let body = ''
      req.on('data', (chunk: string) => (body += chunk))
      req.on('end', () => {
        lastReq = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body }
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Bad Request' }))
      })
    })

    try {
      const client = new ApiClient(baseUrl, TEST_TOKEN)
      await expect(client.getPendingCommands()).rejects.toThrow()
      expect(callCount).toBe(1) // No retry
    } finally {
      server.removeAllListeners('request')
      server.on('request', origHandler)
    }
  })

  it('should send GET to the correct path for getCommand()', async () => {
    const command = { commandId: 'cmd-456', type: 'file_read', payload: { path: '/tmp' }, status: 'PENDING', createdAt: 123 }
    nextResponse = { status: 200, body: command }

    const client = new ApiClient(baseUrl, TEST_TOKEN)
    const result = await client.getCommand('cmd-456')

    expect(lastReq.method).toBe('GET')
    expect(lastReq.url).toBe(API_ENDPOINTS.COMMAND('cmd-456'))
    expect(result).toEqual(command)
  })

  it('should send POST with correct body for heartbeat()', async () => {
    nextResponse = { status: 200, body: {} }

    const client = new ApiClient(baseUrl, TEST_TOKEN)
    await client.heartbeat('agent-1', {
      platform: 'linux',
      arch: 'x64',
      cpuUsage: 50,
      memoryUsage: 60,
      uptime: 1000,
    })

    expect(lastReq.method).toBe('POST')
    expect(lastReq.url).toBe(API_ENDPOINTS.HEARTBEAT)
    const body = JSON.parse(lastReq.body)
    expect(body.agentId).toBe('agent-1')
    expect(body.systemInfo).toEqual({
      platform: 'linux',
      arch: 'x64',
      cpuUsage: 50,
      memoryUsage: 60,
      uptime: 1000,
    })
  })
})
