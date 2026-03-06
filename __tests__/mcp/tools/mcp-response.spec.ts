import { getErrorMessage, mcpErrorResponse, mcpTextResponse, withMcpErrorHandling } from '../../../src/mcp/tools/mcp-response'

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
  })
})
