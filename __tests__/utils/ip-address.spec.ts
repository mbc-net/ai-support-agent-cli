import { canonicalIpAddress } from '../../src/utils/ip-address'

describe('canonicalIpAddress', () => {
  it.each([
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::ffff:7f00:1', '127.0.0.1'],
    ['0:0:0:0:0:ffff:7f00:1', '127.0.0.1'],
    ['::FFFF:AC12:0002', '172.18.0.2'],
    ['0000:0000:0000:0000:0000:ffff:a9fe:a9fe', '169.254.169.254'],
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['fe80::1', 'fe80::1'],
    ['2001:db8::ffff:7f00:1', '2001:db8::ffff:7f00:1'],
    ['not-an-ip', 'not-an-ip'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(canonicalIpAddress(input)).toBe(expected)
  })

  it('undefined は空文字', () => {
    expect(canonicalIpAddress(undefined)).toBe('')
  })
})
