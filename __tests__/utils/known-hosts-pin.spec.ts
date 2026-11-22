/**
 * Tests for src/utils/known-hosts-pin.ts — the read-only lookup of a host key
 * pinned (via TOFU) by server setup in its persistent known_hosts file.
 */
import { createHash, createHmac, randomBytes } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { createSshHostVerifier } from '../../src/utils/ssh-host-key'
import {
  findPinnedHostKey,
  knownHostsLookupName,
  readPinnedHostKey,
  sshKeyFingerprint,
} from '../../src/utils/known-hosts-pin'

function sshString(value: Buffer | string): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length)
  return Buffer.concat([len, body])
}

function keyBlob(type: string): Buffer {
  if (type === 'ssh-ed25519') return Buffer.concat([sshString(type), sshString(randomBytes(32))])
  if (type.startsWith('ecdsa-sha2-')) {
    return Buffer.concat([sshString(type), sshString(type.slice('ecdsa-sha2-'.length)), sshString(randomBytes(65))])
  }
  return Buffer.concat([sshString(type), sshString(Buffer.from([1, 0, 1])), sshString(randomBytes(257))])
}

function keyLine(hosts: string, type: string, blob: Buffer = keyBlob(type), marker = ''): { line: string; blob: Buffer } {
  return { line: `${marker ? `${marker} ` : ''}${hosts} ${type} ${blob.toString('base64')} comment@host`, blob }
}

function hashed(name: string, salt: Buffer = randomBytes(20)): string {
  const digest = createHmac('sha1', salt).update(name).digest()
  return `|1|${salt.toString('base64')}|${digest.toString('base64')}`
}

function expectedFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

describe('knownHostsLookupName', () => {
  it('uses the bare host for port 22 and [host]:port otherwise, lowercased like ssh', () => {
    expect(knownHostsLookupName('DB1.Internal', 22)).toBe('db1.internal')
    expect(knownHostsLookupName('db1.internal', 2222)).toBe('[db1.internal]:2222')
  })
})

describe('sshKeyFingerprint', () => {
  it('produces the canonical OpenSSH SHA256 fingerprint accepted by createSshHostVerifier', () => {
    const blob = keyBlob('ssh-ed25519')
    const fp = sshKeyFingerprint(blob)
    expect(fp).toBe(expectedFingerprint(blob))
    expect(fp).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(createSshHostVerifier(fp)(blob)).toBe(true)
  })
})

describe('findPinnedHostKey', () => {
  it('matches a plain host entry', () => {
    const { line, blob } = keyLine('db1.internal', 'ssh-ed25519')
    expect(findPinnedHostKey(`${line}\n`, 'db1.internal', 22)).toEqual({
      ok: true,
      fingerprint: expectedFingerprint(blob),
      keyType: 'ssh-ed25519',
      hostKeyAlgorithms: ['ssh-ed25519'],
    })
  })

  it('matches case-insensitively', () => {
    const { line, blob } = keyLine('DB1.internal', 'ssh-ed25519')
    const result = findPinnedHostKey(line, 'db1.INTERNAL', 22)
    expect(result).toMatchObject({ ok: true, fingerprint: expectedFingerprint(blob) })
  })

  it('matches a hashed entry for port 22 (HMAC-SHA1 of the bare host)', () => {
    const { line, blob } = keyLine(hashed('db1.internal'), 'ecdsa-sha2-nistp256')
    expect(findPinnedHostKey(line, 'db1.internal', 22)).toEqual({
      ok: true,
      fingerprint: expectedFingerprint(blob),
      keyType: 'ecdsa-sha2-nistp256',
      hostKeyAlgorithms: ['ecdsa-sha2-nistp256'],
    })
  })

  it('matches a hashed entry for a non-22 port only via [host]:port', () => {
    const portEntry = keyLine(hashed('[db1.internal]:2222'), 'ssh-ed25519')
    expect(findPinnedHostKey(portEntry.line, 'db1.internal', 2222)).toMatchObject({
      ok: true,
      fingerprint: expectedFingerprint(portEntry.blob),
    })
    expect(findPinnedHostKey(portEntry.line, 'db1.internal', 22)).toEqual({ ok: false, reason: 'no-match' })
    const bareEntry = keyLine(hashed('db1.internal'), 'ssh-ed25519')
    expect(findPinnedHostKey(bareEntry.line, 'db1.internal', 2222)).toEqual({ ok: false, reason: 'no-match' })
  })

  it('matches a plain [host]:port entry only for that port', () => {
    const { line, blob } = keyLine('[10.0.0.5]:2222', 'ssh-ed25519')
    expect(findPinnedHostKey(line, '10.0.0.5', 2222)).toMatchObject({ ok: true, fingerprint: expectedFingerprint(blob) })
    expect(findPinnedHostKey(line, '10.0.0.5', 22)).toEqual({ ok: false, reason: 'no-match' })
    expect(findPinnedHostKey(line, '10.0.0.5', 2200)).toEqual({ ok: false, reason: 'no-match' })
  })

  it('matches any host of a comma-separated list, honouring wildcards and negation', () => {
    const { line, blob } = keyLine('other.internal,db1.internal,10.0.0.5', 'ssh-ed25519')
    expect(findPinnedHostKey(line, '10.0.0.5', 22)).toMatchObject({ ok: true, fingerprint: expectedFingerprint(blob) })
    expect(findPinnedHostKey(line, 'db1.internal', 22)).toMatchObject({ ok: true })
    expect(findPinnedHostKey(line, 'db2.internal', 22)).toEqual({ ok: false, reason: 'no-match' })

    const wildcard = keyLine('*.internal,!db9.internal', 'ssh-ed25519')
    expect(findPinnedHostKey(wildcard.line, 'db1.internal', 22)).toMatchObject({ ok: true })
    expect(findPinnedHostKey(wildcard.line, 'db9.internal', 22)).toEqual({ ok: false, reason: 'no-match' })
    expect(findPinnedHostKey(wildcard.line, 'db1.internalx', 22)).toEqual({ ok: false, reason: 'no-match' })
  })

  it('ignores comments, blank lines, @cert-authority and malformed lines', () => {
    const ca = keyLine('db1.internal', 'ssh-ed25519', undefined, '@cert-authority')
    const content = [
      '# db1.internal ssh-ed25519 AAAA',
      '',
      '   ',
      ca.line,
      'db1.internal ssh-ed25519 not*base64',
      // key type field disagrees with the type inside the blob
      `db1.internal ssh-rsa ${keyBlob('ssh-ed25519').toString('base64')}`,
      'db1.internal',
      `|1|bad|hash ssh-ed25519 ${keyBlob('ssh-ed25519').toString('base64')}`,
    ].join('\n')
    expect(findPinnedHostKey(content, 'db1.internal', 22)).toEqual({ ok: false, reason: 'no-match' })
  })

  it('returns no-match for an empty file or another host', () => {
    expect(findPinnedHostKey('', 'db1.internal', 22)).toEqual({ ok: false, reason: 'no-match' })
    const { line } = keyLine('db2.internal', 'ssh-ed25519')
    expect(findPinnedHostKey(line, 'db1.internal', 22)).toEqual({ ok: false, reason: 'no-match' })
  })

  it('never trusts a key listed as @revoked', () => {
    const blob = keyBlob('ssh-ed25519')
    const content = [
      keyLine('db1.internal', 'ssh-ed25519', blob).line,
      keyLine('*', 'ssh-ed25519', blob, '@revoked').line,
    ].join('\n')
    expect(findPinnedHostKey(content, 'db1.internal', 22)).toEqual({ ok: false, reason: 'no-match' })
  })

  it('falls back to a non-revoked key of another type when the preferred one is revoked', () => {
    const revoked = keyBlob('ssh-ed25519')
    const rsa = keyLine('db1.internal', 'ssh-rsa')
    const content = [
      keyLine('db1.internal', 'ssh-ed25519', revoked).line,
      rsa.line,
      keyLine('db1.internal', 'ssh-ed25519', revoked, '@revoked').line,
    ].join('\n')
    expect(findPinnedHostKey(content, 'db1.internal', 22)).toEqual({
      ok: true,
      fingerprint: expectedFingerprint(rsa.blob),
      keyType: 'ssh-rsa',
      hostKeyAlgorithms: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
    })
  })

  it('deduplicates the same key recorded more than once (plain + hashed)', () => {
    const blob = keyBlob('ssh-ed25519')
    const content = [
      keyLine('db1.internal', 'ssh-ed25519', blob).line,
      keyLine(hashed('db1.internal'), 'ssh-ed25519', blob).line,
    ].join('\n')
    expect(findPinnedHostKey(content, 'db1.internal', 22)).toMatchObject({ ok: true, fingerprint: expectedFingerprint(blob) })
  })

  it('picks the most preferred key type when several types are pinned', () => {
    const ed = keyLine('db1.internal', 'ssh-ed25519')
    const content = [
      keyLine('db1.internal', 'ssh-rsa').line,
      keyLine('db1.internal', 'ecdsa-sha2-nistp256').line,
      ed.line,
    ].join('\n')
    expect(findPinnedHostKey(content, 'db1.internal', 22)).toEqual({
      ok: true,
      fingerprint: expectedFingerprint(ed.blob),
      keyType: 'ssh-ed25519',
      hostKeyAlgorithms: ['ssh-ed25519'],
    })
  })

  it('rejects two different keys of the chosen type as ambiguous', () => {
    const content = [
      keyLine('db1.internal', 'ssh-ed25519').line,
      keyLine(hashed('db1.internal'), 'ssh-ed25519').line,
    ].join('\n')
    expect(findPinnedHostKey(content, 'db1.internal', 22)).toEqual({ ok: false, reason: 'ambiguous' })
  })

  it('ignores key types ssh2 cannot verify (e.g. ssh-dss)', () => {
    const { line } = keyLine('db1.internal', 'ssh-dss')
    expect(findPinnedHostKey(line, 'db1.internal', 22)).toEqual({ ok: false, reason: 'no-match' })
  })

  it('handles CRLF line endings', () => {
    const { line, blob } = keyLine('db1.internal', 'ssh-ed25519')
    expect(findPinnedHostKey(`# c\r\n${line}\r\n`, 'db1.internal', 22)).toMatchObject({
      ok: true,
      fingerprint: expectedFingerprint(blob),
    })
  })
})

describe('readPinnedHostKey', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'known-hosts-pin-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads the pinned key from the file', async () => {
    const { line, blob } = keyLine('db1.internal', 'ssh-ed25519')
    const file = path.join(dir, 'kh')
    fs.writeFileSync(file, `${line}\n`)
    expect(await readPinnedHostKey(file, 'db1.internal', 22)).toMatchObject({
      ok: true,
      fingerprint: expectedFingerprint(blob),
    })
  })

  it('reports no-file for a missing file and never creates it (or its directory)', async () => {
    const missingDir = path.join(dir, 'missing')
    const file = path.join(missingDir, 'kh')
    expect(await readPinnedHostKey(file, 'db1.internal', 22)).toEqual({ ok: false, reason: 'no-file' })
    expect(fs.existsSync(missingDir)).toBe(false)
    expect(await readPinnedHostKey(path.join(dir, 'kh'), 'db1.internal', 22)).toEqual({ ok: false, reason: 'no-file' })
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('rejects a path that is not a regular file', async () => {
    await expect(readPinnedHostKey(dir, 'db1.internal', 22)).rejects.toThrow()
  })
})
