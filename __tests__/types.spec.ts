import { errorResult, isSupportedSshAuthType, successResult } from '../src/types'

describe('successResult', () => {
  it('should create a success result with data', () => {
    const result = successResult('hello')
    expect(result).toEqual({ success: true, data: 'hello' })
  })

  it('should create a success result with object data', () => {
    const data = { key: 'value', count: 42 }
    const result = successResult(data)
    expect(result).toEqual({ success: true, data })
  })

  it('should create a success result with null data', () => {
    const result = successResult(null)
    expect(result).toEqual({ success: true, data: null })
  })
})

describe('errorResult', () => {
  it('should create an error result with message', () => {
    const result = errorResult('something failed')
    expect(result).toEqual({ success: false, error: 'something failed' })
  })

  it('should create an error result with data', () => {
    const result = errorResult('failed', 'partial output')
    expect(result).toEqual({ success: false, error: 'failed', data: 'partial output' })
  })

  it('should not include data key when data is undefined', () => {
    const result = errorResult('failed')
    expect(result).toEqual({ success: false, error: 'failed' })
    expect('data' in result).toBe(false)
  })

  it('should include data when data is null', () => {
    const result = errorResult('failed', null)
    expect(result).toEqual({ success: false, error: 'failed', data: null })
  })

  it('should include data when data is false', () => {
    const result = errorResult('failed', false)
    expect(result).toEqual({ success: false, error: 'failed', data: false })
  })
})

describe('isSupportedSshAuthType', () => {
  it('should return true for "password"', () => {
    expect(isSupportedSshAuthType('password')).toBe(true)
  })

  it('should return true for "privateKey"', () => {
    expect(isSupportedSshAuthType('privateKey')).toBe(true)
  })

  it('should return false for an unrecognized authType', () => {
    expect(isSupportedSshAuthType('token')).toBe(false)
  })

  it('should return false for an empty string', () => {
    expect(isSupportedSshAuthType('')).toBe(false)
  })
})
