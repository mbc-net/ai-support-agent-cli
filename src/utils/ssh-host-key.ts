import { createHash, timingSafeEqual } from 'crypto'

/** Require an out-of-band trusted OpenSSH SHA256 pin; never learn keys from this connection. */
export function createSshHostVerifier(fingerprint: unknown): (key: Buffer) => boolean {
  if (typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) {
    throw new Error('SSH hostKeyFingerprint is required (OpenSSH SHA256 fingerprint)')
  }
  const expected = Buffer.from(fingerprint.slice(7), 'base64')
  if (expected.length !== 32 || expected.toString('base64').replace(/=+$/, '') !== fingerprint.slice(7)) {
    throw new Error('SSH hostKeyFingerprint is not a canonical SHA256 fingerprint')
  }
  return (key: Buffer): boolean => Buffer.isBuffer(key)
    && timingSafeEqual(createHash('sha256').update(key).digest(), expected)
}
