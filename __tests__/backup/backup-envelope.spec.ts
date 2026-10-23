import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'crypto'
import { encryptBackupStream } from '../../src/backup/backup-envelope'

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()
async function collect(input: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(chunk)
  return Buffer.concat(chunks)
}
async function* bytes(...chunks: Buffer[]): AsyncGenerator<Buffer> { yield* chunks }
function decrypt(encoded: Buffer): Buffer {
  expect(encoded.subarray(0, 8).toString()).toBe('BYOBKP01')
  const end = 12 + encoded.readUInt32BE(8)
  const header = JSON.parse(encoded.subarray(12, end).toString())
  const key = privateDecrypt({ key: rsa.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(header.wrappedKey, 'base64'))
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'))
  cipher.setAAD(encoded.subarray(0, end))
  cipher.setAuthTag(encoded.subarray(-16))
  return Buffer.concat([cipher.update(encoded.subarray(end, -16)), cipher.final()])
}

describe('backup envelope stream', () => {
  it.each([Buffer.alloc(0), Buffer.from('secret database content'), Buffer.alloc(200000, 97)])('round trips binary data (case %#)', async (plain) => {
    const encoded = await collect(encryptBackupStream(bytes(plain.subarray(0, 3), plain.subarray(3)), publicPem, 1000000))
    expect(decrypt(encoded)).toEqual(plain)
    if (plain.length > 10) expect(encoded.includes(plain)).toBe(false)
  })
  it('uses fresh keys and IVs for identical data', async () => {
    const one = await collect(encryptBackupStream(bytes(Buffer.from('same')), publicPem, 100))
    const two = await collect(encryptBackupStream(bytes(Buffer.from('same')), publicPem, 100))
    expect(one.equals(two)).toBe(false)
    expect(decrypt(one)).toEqual(decrypt(two))
  })
  it('authenticates ciphertext and the envelope header', async () => {
    const encoded = await collect(encryptBackupStream(bytes(Buffer.from('payload')), publicPem, 100))
    const bodyTamper = Buffer.from(encoded); bodyTamper[bodyTamper.length - 17] ^= 1
    expect(() => decrypt(bodyTamper)).toThrow()
    const headerTamper = Buffer.from(encoded)
    const index = headerTamper.indexOf(Buffer.from('AES-256-GCM')); headerTamper[index] = 66
    expect(() => decrypt(headerTamper)).toThrow()
  })
  it('rejects a private key, unsupported key or weak RSA before consuming data', async () => {
    const source = { [Symbol.asyncIterator]: jest.fn() }
    const ed = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const privatePem = rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    for (const pem of [privatePem, publicPem + privatePem, ed, weak, 'invalid']) {
      await expect(collect(encryptBackupStream(source, pem, 100))).rejects.toThrow('BACKUP_UNSUPPORTED_PUBLIC_KEY')
    }
    expect(source[Symbol.asyncIterator]).not.toHaveBeenCalled()
  })
  it('does not read the source when cancelled after emitting the header', async () => {
    const source = { [Symbol.asyncIterator]: jest.fn() }
    const controller = new AbortController()
    const encrypted = encryptBackupStream(source, publicPem, 100, controller.signal)
    await encrypted.next()
    controller.abort()
    await expect(encrypted.next()).rejects.toThrow('BACKUP_EXPORT_ABORTED')
    expect(source[Symbol.asyncIterator]).not.toHaveBeenCalled()
  })
  it('closes the source when the size limit is reached', async () => {
    let closed = false
    async function* source() {
      try { yield Buffer.alloc(101) } finally { closed = true }
    }
    await expect(collect(encryptBackupStream(source(), publicPem, 100))).rejects.toThrow('BACKUP_EXPORT_SIZE_LIMIT')
    expect(closed).toBe(true)
  })
  it('enforces the plaintext bound and propagates cancellation', async () => {
    await expect(collect(encryptBackupStream(bytes(Buffer.alloc(101)), publicPem, 100))).rejects.toThrow('BACKUP_EXPORT_SIZE_LIMIT')
    const controller = new AbortController(); controller.abort()
    await expect(collect(encryptBackupStream(bytes(Buffer.from('x')), publicPem, 100, controller.signal))).rejects.toThrow('BACKUP_EXPORT_ABORTED')
    await expect(collect(encryptBackupStream(bytes(), publicPem, 2 ** 36))).rejects.toThrow('BACKUP_EXPORT_INVALID_LIMIT')
  })
})
