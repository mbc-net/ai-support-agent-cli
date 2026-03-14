import { AxiosError, AxiosHeaders } from 'axios'

import {
  getErrorMessage,
  mcpErrorResponse,
  mcpImageResponse,
  mcpTextResponse,
  withMcpErrorHandling,
} from '../../../src/mcp/tools/mcp-response'

describe('mcp-response helpers', () => {
  describe('mcpTextResponse', () => {
    it('should return a text content response', () => {
      const result = mcpTextResponse('hello')
      expect(result).toEqual({
        content: [{ type: 'text', text: 'hello' }],
      })
    })

    it('should handle empty string', () => {
      const result = mcpTextResponse('')
      expect(result).toEqual({
        content: [{ type: 'text', text: '' }],
      })
    })

    it('should not include isError', () => {
      const result = mcpTextResponse('data')
      expect(result).not.toHaveProperty('isError')
    })
  })

  describe('mcpErrorResponse', () => {
    it('should return an error content response with Error prefix', () => {
      const result = mcpErrorResponse('something went wrong')
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: something went wrong' }],
        isError: true,
      })
    })

    it('should set isError to true', () => {
      const result = mcpErrorResponse('fail')
      expect(result.isError).toBe(true)
    })
  })

  describe('mcpImageResponse', () => {
    it('should return an image content response', () => {
      const result = mcpImageResponse('base64data', 'image/png')
      expect(result).toEqual({
        content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
      })
    })

    it('should not include isError', () => {
      const result = mcpImageResponse('data', 'image/jpeg')
      expect(result).not.toHaveProperty('isError')
    })
  })

  describe('getErrorMessage (re-exported from utils)', () => {
    it('should extract message from Error instance', () => {
      const error = new Error('test error')
      expect(getErrorMessage(error)).toBe('test error')
    })

    it('should convert non-Error to string', () => {
      expect(getErrorMessage('string error')).toBe('string error')
    })

    it('should convert number to string', () => {
      expect(getErrorMessage(42)).toBe('42')
    })

    it('should convert null to string', () => {
      expect(getErrorMessage(null)).toBe('null')
    })

    it('should convert undefined to string', () => {
      expect(getErrorMessage(undefined)).toBe('undefined')
    })
  })

  describe('getErrorMessage', () => {
    it('should extract message from Axios error response data', () => {
      const error = new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 404,
        statusText: 'Not Found',
        data: { message: 'Credentials not found for account xyz' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
      expect(getErrorMessage(error)).toBe('[404] Credentials not found for account xyz')
    })

    it('should extract error field from Axios error response data', () => {
      const error = new AxiosError('Request failed with status code 422', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 422,
        statusText: 'Unprocessable Entity',
        data: { error: 'SSO_AUTH_REQUIRED' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
      expect(getErrorMessage(error)).toBe('[422] SSO_AUTH_REQUIRED')
    })

    it('should fall back to HTTP status when no message or error in data', () => {
      const error = new AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 500,
        statusText: 'Internal Server Error',
        data: { some: 'other field' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
      expect(getErrorMessage(error)).toBe('HTTP 500: Request failed with status code 500')
    })

    it('should fall back to HTTP status when response data is undefined', () => {
      const error = new AxiosError('Request failed with status code 502', 'ERR_BAD_RESPONSE', undefined, undefined, {
        status: 502,
        statusText: 'Bad Gateway',
        data: undefined,
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
      expect(getErrorMessage(error)).toBe('HTTP 502: Request failed with status code 502')
    })

    it('should fall back to getErrorMessage for AxiosError without response', () => {
      const error = new AxiosError('Network Error', 'ERR_NETWORK')
      expect(getErrorMessage(error)).toBe('Network Error')
    })

    it('should fall back to getErrorMessage for non-Axios Error', () => {
      const error = new Error('generic error')
      expect(getErrorMessage(error)).toBe('generic error')
    })

    it('should fall back to getErrorMessage for non-Error values', () => {
      expect(getErrorMessage('string error')).toBe('string error')
      expect(getErrorMessage(42)).toBe('42')
      expect(getErrorMessage(null)).toBe('null')
    })

    it('should prefer message over error field when both exist', () => {
      const error = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 400,
        statusText: 'Bad Request',
        data: { message: 'Detailed message', error: 'ERROR_CODE' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
      expect(getErrorMessage(error)).toBe('[400] Detailed message')
    })
  })

  describe('withMcpErrorHandling', () => {
    it('should return result on success', async () => {
      const expected = mcpTextResponse('ok')
      const result = await withMcpErrorHandling(async () => expected)
      expect(result).toEqual(expected)
    })

    it('should catch Error and return mcpErrorResponse', async () => {
      const result = await withMcpErrorHandling(async () => {
        throw new Error('something broke')
      })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: something broke' }],
        isError: true,
      })
    })

    it('should catch non-Error (string) and return mcpErrorResponse', async () => {
      const result = await withMcpErrorHandling(async () => {
        throw 'string error'
      })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: string error' }],
        isError: true,
      })
    })

    it('should use getErrorMessage for Axios errors', async () => {
      const axiosError = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
        status: 403,
        statusText: 'Forbidden',
        data: { message: 'Access denied to resource' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      })
      const result = await withMcpErrorHandling(async () => {
        throw axiosError
      })
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: [403] Access denied to resource' }],
        isError: true,
      })
    })
  })
})
