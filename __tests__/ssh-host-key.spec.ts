import { createHash } from 'crypto'
import { createSshHostVerifier } from '../src/utils/ssh-host-key'

const key = Buffer.from('trusted raw SSH key')
const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`

describe('SSH host-key pin', () => {
  it.each([undefined, null, '', 'SHA256:short', 'MD5:aa:bb', `SHA256:${'A'.repeat(42)}B`])('rejects missing/malformed pin %s', (value) => {
    expect(() => createSshHostVerifier(value)).toThrow('hostKeyFingerprint')
  })
  it('accepts only the pinned raw key', () => {
    const verifier = createSshHostVerifier(fingerprint)
    expect(verifier(key)).toBe(true)
    expect(verifier(Buffer.from('attacker raw SSH key'))).toBe(false)
    expect(verifier('invalid' as unknown as Buffer)).toBe(false)
  })
})
