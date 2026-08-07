import { isPlainObject } from '../../src/utils/is-plain-object'

describe('isPlainObject', () => {
  it('returns true for a plain object literal', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject({ a: 1, b: 'x' })).toBe(true)
  })

  it('returns true for objects created from other constructors', () => {
    expect(isPlainObject(new Date())).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
  })

  it('returns false for arrays', () => {
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject([1, 2, 3])).toBe(false)
  })

  it('returns false for null', () => {
    expect(isPlainObject(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isPlainObject(undefined)).toBe(false)
  })

  it('returns false for primitives', () => {
    expect(isPlainObject('string')).toBe(false)
    expect(isPlainObject(42)).toBe(false)
    expect(isPlainObject(true)).toBe(false)
    expect(isPlainObject(Symbol('s'))).toBe(false)
  })

  it('narrows the type to Record<string, unknown> for indexing', () => {
    const value: unknown = { key: 'value' }
    if (isPlainObject(value)) {
      // Type is narrowed — indexing by string key compiles.
      expect(value['key']).toBe('value')
    } else {
      throw new Error('expected value to be a plain object')
    }
  })
})
