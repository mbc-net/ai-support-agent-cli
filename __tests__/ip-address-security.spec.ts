import { Address6 } from 'ip-address'

describe('IPv6 link-local classification used by SOCKS dependencies', () => {
  it.each(['fe80::1', 'fe90::1', 'febf:ffff::1'])(
    'recognizes %s within fe80::/10',
    (address) => expect(new Address6(address).isLinkLocal()).toBe(true),
  )

  it.each(['fec0::1', '2001:db8::1'])(
    'does not classify %s outside fe80::/10 as link-local',
    (address) => expect(new Address6(address).isLinkLocal()).toBe(false),
  )
})
