import { AxiosError, AxiosHeaders } from 'axios'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerCredentialsTool } from '../../../src/mcp/tools/credentials'

jest.mock('../../../src/api-client')
jest.mock('../../../src/logger')

describe('credentials tool', () => {
  let toolCallback: (args: { type: string; name: string }) => Promise<unknown>

  function setupTool(mockClient: Partial<ApiClient>) {
    const mockServer = {
      tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
        toolCallback = cb
      }),
    } as unknown as McpServer

    registerCredentialsTool(mockServer, mockClient as ApiClient)
  }

  describe('registerCredentialsTool', () => {
    it('should register the tool on the server', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerCredentialsTool(mockServer, mockClient)

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'get_credentials',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })
  })

  describe('AWS credentials', () => {
    it('should return AWS credentials', async () => {
      setupTool({
        getAwsCredentials: jest.fn().mockResolvedValue({
          accessKeyId: 'AKID',
          secretAccessKey: 'SECRET',
          sessionToken: 'TOKEN',
          region: 'ap-northeast-1',
        }),
      })

      const result = await toolCallback({ type: 'aws', name: 'account-1' }) as { content: Array<{ text: string }> }
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.accessKeyId).toBe('AKID')
      expect(parsed.secretAccessKey).toBe('SECRET')
      expect(parsed.sessionToken).toBe('TOKEN')
      expect(parsed.region).toBe('ap-northeast-1')
    })
  })

  describe('DB credentials', () => {
    it('should return DB credentials', async () => {
      setupTool({
        getDbCredentials: jest.fn().mockResolvedValue({
          name: 'MAIN',
          engine: 'mysql',
          host: 'localhost',
          port: 3306,
          database: 'testdb',
          user: 'root',
          password: 'pass',
        }),
      })

      const result = await toolCallback({ type: 'db', name: 'MAIN' }) as { content: Array<{ text: string }> }
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.name).toBe('MAIN')
      expect(parsed.engine).toBe('mysql')
      expect(parsed.password).toBe('pass')
    })
  })

  describe('unknown credential type', () => {
    it('should return error for unknown credential type', async () => {
      setupTool({
        getAwsCredentials: jest.fn(),
        getDbCredentials: jest.fn(),
      })

      const result = await toolCallback({ type: 'unknown' as 'aws', name: 'test' }) as {
        content: Array<{ text: string }>
        isError: boolean
      }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown credential type')
    })
  })

  describe('error handling', () => {
    it('should handle API errors', async () => {
      setupTool({
        getAwsCredentials: jest.fn().mockRejectedValue(new Error('Unauthorized')),
      })

      const result = await toolCallback({ type: 'aws', name: 'bad-account' })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Unauthorized' }],
        isError: true,
      })
    })

    it('should handle non-Error throws', async () => {
      setupTool({
        getDbCredentials: jest.fn().mockRejectedValue('string error'),
      })

      const result = await toolCallback({ type: 'db', name: 'bad' })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: string error' }],
        isError: true,
      })
    })

    it('should return user-friendly message for SSO_AUTH_REQUIRED error (error field)', async () => {
      const axiosError = new AxiosError('Request failed with status code 422', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 422,
        statusText: 'Unprocessable Entity',
        data: { error: 'SSO_AUTH_REQUIRED', accountId: '123456789012' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })

      setupTool({
        getAwsCredentials: jest.fn().mockRejectedValue(axiosError),
      })

      const result = await toolCallback({ type: 'aws', name: 'my-account' }) as { content: Array<{ text: string }>; isError: boolean }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('AWS SSO authentication has expired')
      expect(result.content[0].text).toContain('my-account')
    })

    it('should return user-friendly message for SSO_AUTH_REQUIRED error (errorCode field)', async () => {
      const axiosError = new AxiosError('Request failed with status code 422', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 422,
        statusText: 'Unprocessable Entity',
        data: { errorCode: 'SSO_AUTH_REQUIRED', message: 'SSO token expired' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })

      setupTool({
        getAwsCredentials: jest.fn().mockRejectedValue(axiosError),
      })

      const result = await toolCallback({ type: 'aws', name: 'prod-account' }) as { content: Array<{ text: string }>; isError: boolean }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('AWS SSO authentication has expired')
      expect(result.content[0].text).toContain('prod-account')
      expect(result.content[0].text).toContain('re-authenticate via the admin console')
    })

    it('should include detailed Axios error for non-SSO AWS errors', async () => {
      const axiosError = new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        data: { message: 'AWS account not configured' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })

      setupTool({
        getAwsCredentials: jest.fn().mockRejectedValue(axiosError),
      })

      const result = await toolCallback({ type: 'aws', name: 'unknown-account' }) as { content: Array<{ text: string }>; isError: boolean }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('Error: [404] AWS account not configured')
    })

    it('should include detailed Axios error for DB credential failures', async () => {
      const axiosError = new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 500,
        statusText: 'Internal Server Error',
        data: { message: 'Database connection pool exhausted' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })

      setupTool({
        getDbCredentials: jest.fn().mockRejectedValue(axiosError),
      })

      const result = await toolCallback({ type: 'db', name: 'MAIN' }) as { content: Array<{ text: string }>; isError: boolean }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('Error: [500] Database connection pool exhausted')
    })

    it('should include HTTP status for Axios error without message in data', async () => {
      const axiosError = new AxiosError('Request failed with status code 502', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 502,
        statusText: 'Bad Gateway',
        data: {},
        headers: {},
        config: { headers: new AxiosHeaders() },
      })

      setupTool({
        getDbCredentials: jest.fn().mockRejectedValue(axiosError),
      })

      const result = await toolCallback({ type: 'db', name: 'MAIN' }) as { content: Array<{ text: string }>; isError: boolean }
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toBe('Error: HTTP 502: Request failed with status code 502')
    })
  })
})
