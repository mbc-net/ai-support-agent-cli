import { safeJsonParse } from '../../src/utils/json-parse'

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    const result = safeJsonParse<{ name: string }>('{"name":"test"}')
    expect(result).toEqual({ name: 'test' })
  })

  it('should return undefined for invalid JSON', () => {
    expect(safeJsonParse('not json')).toBeUndefined()
  })

  it('should return undefined for empty string', () => {
    expect(safeJsonParse('')).toBeUndefined()
  })

  it('should parse JSON arrays', () => {
    const result = safeJsonParse<number[]>('[1,2,3]')
    expect(result).toEqual([1, 2, 3])
  })

  it('should parse JSON primitives', () => {
    expect(safeJsonParse<number>('42')).toBe(42)
    expect(safeJsonParse<string>('"hello"')).toBe('hello')
    expect(safeJsonParse<boolean>('true')).toBe(true)
    expect(safeJsonParse<null>('null')).toBeNull()
  })
})
