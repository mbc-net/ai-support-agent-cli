import { parseToken, extractTokenId, extractTenantCodeFromToken } from '../../src/utils/token-utils'

describe('parseToken', () => {
  it('returns parsed components for valid token', () => {
    expect(parseToken('tenant:tokenid:rawtoken')).toEqual({
      tenantCode: 'tenant',
      tokenId: 'tokenid',
      rawToken: 'rawtoken',
    })
  })

  it('returns null for token with fewer than 3 parts', () => {
    expect(parseToken('tenant:tokenid')).toBeNull()
    expect(parseToken('onlyonepart')).toBeNull()
  })

  it('returns null for token with more than 3 parts', () => {
    expect(parseToken('tenant:tokenid:raw:extra')).toBeNull()
  })

  it('returns null when tenantCode is empty', () => {
    expect(parseToken(':tokenid:rawtoken')).toBeNull()
  })

  it('returns null when tokenId is empty', () => {
    expect(parseToken('tenant::rawtoken')).toBeNull()
  })

  it('returns null when rawToken is empty', () => {
    expect(parseToken('tenant:tokenid:')).toBeNull()
  })
})

describe('extractTokenId', () => {
  it('returns the middle part for a valid 3-part token', () => {
    expect(extractTokenId('tenant:tokenid:rawtoken')).toBe('tokenid')
  })

  it('returns empty string when middle part is empty', () => {
    expect(extractTokenId('tenant::rawtoken')).toBe('')
  })

  it('returns undefined for token with fewer than 3 parts', () => {
    expect(extractTokenId('tenant:tokenid')).toBeUndefined()
  })

  it('returns undefined for token with more than 3 parts', () => {
    expect(extractTokenId('a:b:c:d')).toBeUndefined()
  })
})

describe('extractTenantCodeFromToken', () => {
  it('returns the first part for a valid 3-part token', () => {
    expect(extractTenantCodeFromToken('mbc:tokenid:rawtoken')).toBe('mbc')
  })

  it('returns the first part when there are more than 3 parts', () => {
    expect(extractTenantCodeFromToken('mbc:tokenid:raw:extra')).toBe('mbc')
  })

  it('returns empty string for token with fewer than 3 parts', () => {
    expect(extractTenantCodeFromToken('tenant:tokenid')).toBe('')
    expect(extractTenantCodeFromToken('onlyonepart')).toBe('')
  })
})
