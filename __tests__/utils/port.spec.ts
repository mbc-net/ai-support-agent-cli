import { isValidPort } from '../../src/utils/port'

describe('isValidPort', () => {
  it('accepts the valid TCP port range boundaries', () => {
    expect(isValidPort(1)).toBe(true)
    expect(isValidPort(80)).toBe(true)
    expect(isValidPort(65535)).toBe(true)
  })

  it('rejects ports outside 1-65535', () => {
    expect(isValidPort(0)).toBe(false)
    expect(isValidPort(65536)).toBe(false)
    expect(isValidPort(-1)).toBe(false)
  })

  it('rejects non-integers', () => {
    expect(isValidPort(3.5)).toBe(false)
    expect(isValidPort(NaN)).toBe(false)
    expect(isValidPort(Infinity)).toBe(false)
  })
})
