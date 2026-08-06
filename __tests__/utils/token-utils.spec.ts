import { bearerHeader, parseToken, extractTokenId, extractTenantCodeFromToken, resolveDirectStartTarget, splitProjectRef } from '../../src/utils/token-utils'

describe('bearerHeader', () => {
  it('prefixes the token with "Bearer "', () => {
    expect(bearerHeader('abc123')).toBe('Bearer abc123')
  })

  it('handles an empty token', () => {
    expect(bearerHeader('')).toBe('Bearer ')
  })
})

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

  it('extracts the tenantCode from a full PAT-format token', () => {
    // PAT format: {tenantCode}:{tokenId}:{rawToken}
    expect(
      extractTenantCodeFromToken('mbc:6f0f1c2e-1111-2222-3333-444455556666:AbC12_rawtoken'),
    ).toBe('mbc')
  })
})

describe('resolveDirectStartTarget', () => {
  const fallback = { tenantCode: 'unknown', projectCode: 'cli-direct' }

  it('returns the fallback when no --project is given', () => {
    expect(resolveDirectStartTarget('mbc:tokenid:rawtoken', undefined, fallback)).toEqual({
      ok: true,
      tenantCode: 'unknown',
      projectCode: 'cli-direct',
    })
  })

  it('derives tenantCode/projectCode from --project matching the token tenant', () => {
    expect(
      resolveDirectStartTarget('mbc:tokenid:rawtoken', 'mbc/MBC_01', fallback),
    ).toEqual({ ok: true, tenantCode: 'mbc', projectCode: 'MBC_01' })
  })

  it('rejects when --project tenant differs from the token tenant', () => {
    expect(
      resolveDirectStartTarget('mbc:tokenid:rawtoken', 'jcci/JCCI_01', fallback),
    ).toEqual({
      ok: false,
      reason: 'tenant-mismatch',
      tokenTenantCode: 'mbc',
      projectTenantCode: 'jcci',
    })
  })

  it('rejects --project without a slash separator', () => {
    expect(resolveDirectStartTarget('mbc:tokenid:rawtoken', 'MBC_01', fallback)).toEqual({
      ok: false,
      reason: 'invalid-project-format',
    })
  })

  it('rejects --project with an empty tenantCode', () => {
    expect(resolveDirectStartTarget('mbc:tokenid:rawtoken', '/MBC_01', fallback)).toEqual({
      ok: false,
      reason: 'invalid-project-format',
    })
  })

  it('rejects --project with an empty projectCode', () => {
    expect(resolveDirectStartTarget('mbc:tokenid:rawtoken', 'mbc/', fallback)).toEqual({
      ok: false,
      reason: 'invalid-project-format',
    })
  })

  it('trusts the --project tenant when the token carries no embedded tenantCode', () => {
    // Non-standard token without colons -> extractTenantCodeFromToken returns ''
    expect(resolveDirectStartTarget('rawtokenonly', 'mbc/MBC_01', fallback)).toEqual({
      ok: true,
      tenantCode: 'mbc',
      projectCode: 'MBC_01',
    })
  })

  it('preserves additional slashes in the projectCode segment', () => {
    expect(
      resolveDirectStartTarget('mbc:tokenid:rawtoken', 'mbc/MBC_01/sub', fallback),
    ).toEqual({ ok: true, tenantCode: 'mbc', projectCode: 'MBC_01/sub' })
  })
})

describe('splitProjectRef', () => {
  it('splits "tenantCode/projectCode" on the first slash', () => {
    expect(splitProjectRef('mbc/MBC_01')).toEqual({
      tenantCode: 'mbc',
      projectCode: 'MBC_01',
    })
  })

  it('keeps everything after the first slash in projectCode', () => {
    expect(splitProjectRef('mbc/MBC_01/sub')).toEqual({
      tenantCode: 'mbc',
      projectCode: 'MBC_01/sub',
    })
  })

  it('returns null when there is no slash', () => {
    expect(splitProjectRef('MBC_01')).toBeNull()
    expect(splitProjectRef('')).toBeNull()
  })

  it('allows an empty tenantCode when the ref starts with a slash', () => {
    expect(splitProjectRef('/MBC_01')).toEqual({
      tenantCode: '',
      projectCode: 'MBC_01',
    })
  })
})
