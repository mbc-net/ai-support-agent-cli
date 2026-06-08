import {
  mcpTextResponse,
  mcpErrorResponse,
  mcpImageResponse,
  mcpTextImageResponse,
  screenshotToBase64,
  withMcpErrorHandling,
} from './mcp-response'

describe('mcp-response', () => {
  describe('mcpTextResponse', () => {
    it('should return a text content item', () => {
      const result = mcpTextResponse('hello')
      expect(result).toEqual({ content: [{ type: 'text', text: 'hello' }] })
    })

    it('should handle empty string', () => {
      expect(mcpTextResponse('')).toEqual({ content: [{ type: 'text', text: '' }] })
    })
  })

  describe('mcpErrorResponse', () => {
    it('should prefix message with "Error: " and set isError flag', () => {
      const result = mcpErrorResponse('something went wrong')
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: something went wrong' }],
        isError: true,
      })
    })

    it('should handle empty message', () => {
      const result = mcpErrorResponse('')
      expect(result.content[0].text).toBe('Error: ')
      expect(result.isError).toBe(true)
    })
  })

  describe('mcpImageResponse', () => {
    it('should return an image content item', () => {
      const result = mcpImageResponse('abc123', 'image/png')
      expect(result).toEqual({
        content: [{ type: 'image', data: 'abc123', mimeType: 'image/png' }],
      })
    })
  })

  describe('mcpTextImageResponse', () => {
    it('should return text and image content items', () => {
      const result = mcpTextImageResponse('page title', 'base64data', 'image/png')
      expect(result).toEqual({
        content: [
          { type: 'text', text: 'page title' },
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
        ],
      })
    })
  })

  describe('screenshotToBase64', () => {
    it('should convert a Buffer to base64 string', () => {
      const buf = Buffer.from('hello world')
      expect(screenshotToBase64(buf)).toBe(buf.toString('base64'))
    })

    it('should produce correct base64 for PNG-like binary data', () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      const result = screenshotToBase64(pngHeader)
      expect(result).toBe('iVBORg==')
    })

    it('should produce the same result as calling .toString("base64") directly', () => {
      const data = Buffer.from('arbitrary content 123')
      expect(screenshotToBase64(data)).toBe(data.toString('base64'))
    })
  })

  describe('withMcpErrorHandling', () => {
    it('should return the result of the wrapped function', async () => {
      const expected = mcpTextResponse('ok')
      const result = await withMcpErrorHandling(async () => expected)
      expect(result).toEqual(expected)
    })

    it('should catch thrown errors and return mcpErrorResponse', async () => {
      const result = await withMcpErrorHandling(async () => {
        throw new Error('boom')
      })
      expect(result).toMatchObject({
        content: [{ type: 'text', text: expect.stringContaining('boom') }],
        isError: true,
      })
    })

    it('should handle non-Error throws', async () => {
      const result = await withMcpErrorHandling(async () => {
        throw 'string error'
      })
      expect(result).toMatchObject({ isError: true })
    })
  })
})
