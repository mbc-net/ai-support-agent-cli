import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'crypto'

// GCM permits at most 2^39 - 256 bits of plaintext under one key/IV.
const MAX_GCM_BYTES = 2 ** 36 - 32
const CHUNK_BYTES = 64 * 1024

/**
 * BYOBKP01 | uint32 BE JSON length | UTF-8 JSON | ciphertext | 16-byte GCM tag.
 * The complete prefix and JSON header are authenticated as AAD. A fresh data key
 * and IV are generated for each object. Only the wrapped key leaves this module.
 * Consumers must abort an incomplete upload when iteration rejects.
 */
export async function* encryptBackupStream(
  source: AsyncIterable<Uint8Array>,
  publicKeyPem: string,
  maxPlaintextBytes: number,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 1 || maxPlaintextBytes > MAX_GCM_BYTES) {
    throw new Error('BACKUP_EXPORT_INVALID_LIMIT')
  }
  const checkAbort = (): void => {
    if (signal?.aborted) throw new Error('BACKUP_EXPORT_ABORTED')
  }
  checkAbort()
  const publicKey = validateBackupPublicKey(publicKeyPem)
  const key = randomBytes(32)
  const iv = randomBytes(12)
  try {
    const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key)
    const header = Buffer.from(JSON.stringify({
      version: 1, algorithm: 'AES-256-GCM', keyAlgorithm: 'RSA-OAEP-SHA256',
      iv: iv.toString('base64'), wrappedKey: wrapped.toString('base64'),
    }))
    const prefix = Buffer.alloc(12)
    prefix.write('BYOBKP01', 'ascii')
    prefix.writeUInt32BE(header.length, 8)
    const aad = Buffer.concat([prefix, header])
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(aad)
    key.fill(0)
    yield aad
    checkAbort()
    let size = 0
    for await (const chunk of source) {
      checkAbort()
      if (!(chunk instanceof Uint8Array)) throw new Error('BACKUP_EXPORT_INVALID_CHUNK')
      size += chunk.byteLength
      if (size > maxPlaintextBytes) throw new Error('BACKUP_EXPORT_SIZE_LIMIT')
      for (let offset = 0; offset < chunk.byteLength; offset += CHUNK_BYTES) {
        checkAbort()
        yield cipher.update(chunk.subarray(offset, offset + CHUNK_BYTES))
      }
    }
    checkAbort()
    const last = cipher.final()
    if (last.length) yield last
    yield cipher.getAuthTag()
  } finally {
    key.fill(0)
  }
}

/** Validate before starting data extraction or creating remote uploads. */
export function validateBackupPublicKey(publicKeyPem: string) {
  // createPublicKey also accepts private keys. Reject those before parsing,
  // including PEM bundles that would otherwise silently ignore a second key.
  let publicKey
  try {
    if (typeof publicKeyPem !== 'string' || publicKeyPem.length > 16384 ||
      !/^-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----\s*$/.test(publicKeyPem)) throw new Error()
    publicKey = createPublicKey(publicKeyPem)
    const bits = publicKey.asymmetricKeyDetails?.modulusLength ?? 0
    if (publicKey.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 8192) throw new Error()
  } catch {
    throw new Error('BACKUP_UNSUPPORTED_PUBLIC_KEY')
  }
  return publicKey
}
