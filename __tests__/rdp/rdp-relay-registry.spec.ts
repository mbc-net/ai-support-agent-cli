import { listActiveRelayAddresses, registerRelayAddress } from '../../src/rdp/rdp-relay-registry'

describe('rdp-relay-registry', () => {
  it('★ 同じアドレスの中継が複数あれば、最後の 1 つが閉じるまで残す', () => {
    const a = registerRelayAddress('10.1.1.1')
    const b = registerRelayAddress('10.1.1.1')
    a()
    expect(listActiveRelayAddresses()).toContain('10.1.1.1')
    b()
    expect(listActiveRelayAddresses()).not.toContain('10.1.1.1')
  })

  it('解除は冪等（二重に呼んでも他の登録を減らさない）', () => {
    const a = registerRelayAddress('10.1.1.2')
    const b = registerRelayAddress('10.1.1.2')
    a()
    a()
    expect(listActiveRelayAddresses()).toContain('10.1.1.2')
    b()
    expect(listActiveRelayAddresses()).not.toContain('10.1.1.2')
  })
})
