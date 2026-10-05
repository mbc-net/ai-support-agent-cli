import { durationSeconds, editPayload } from '../src/vault/management'

describe('Vault management CLI input', () => {
  it('parses bounded integer durations', () => {
    expect(durationSeconds('8h')).toBe(28800)
    expect(durationSeconds('30m')).toBe(1800)
    for (const v of ['0h', '-1h', '1.5h', 'NaN', '999999999999h']) expect(() => durationSeconds(v)).toThrow()
  })
  it('preserves missing schema options and requires explicit secret input', () => {
    expect(editPayload('set', 'FLAG', { value: 'false' })).toEqual({ mode: 'set', name: 'FLAG', value: 'false' })
    expect(() => editPayload('add', 'PASSWORD', { secret: true, value: 'secret' })).toThrow()
    expect(() => editPayload('set', 'FLAG', { value: 'x', stdin: true })).toThrow()
  })
})
