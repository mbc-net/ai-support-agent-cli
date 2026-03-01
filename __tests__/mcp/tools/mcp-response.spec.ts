import { extractErrorMessage, mcpErrorResponse, mcpTextResponse } from '../../../src/mcp/tools/mcp-response'

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

  describe('extractErrorMessage', () => {
    it('should extract message from Error instance', () => {
      const error = new Error('test error')
      expect(extractErrorMessage(error)).toBe('test error')
    })

    it('should convert non-Error to string', () => {
      expect(extractErrorMessage('string error')).toBe('string error')
    })

    it('should convert number to string', () => {
      expect(extractErrorMessage(42)).toBe('42')
    })

    it('should convert null to string', () => {
      expect(extractErrorMessage(null)).toBe('null')
    })

    it('should convert undefined to string', () => {
      expect(extractErrorMessage(undefined)).toBe('undefined')
    })
  })
})
