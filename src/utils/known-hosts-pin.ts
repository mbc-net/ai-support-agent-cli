/**
 * Read-only lookup of a host key that server setup pinned (TOFU via
 * `StrictHostKeyChecking=accept-new`) in its persistent known_hosts file (see
 * `known-hosts-store.ts`). Used by paths that must verify a host strictly but
 * have no out-of-band fingerprint (e.g. readonly_diagnostic against an
 * asset-ledger connection). Never learns or records a key: a host with no
 * pinned key is simply "not pinned".
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto'
import * as fs from 'fs'

const DEFAULT_SSH_PORT = 22

/**
 * Key types ssh2 can verify, in ssh2's own negotiation preference order, with
 * the host-key algorithms that present a key of that type.
 */
const KEY_TYPE_ALGORITHMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['ssh-ed25519', ['ssh-ed25519']],
  ['ecdsa-sha2-nistp256', ['ecdsa-sha2-nistp256']],
  ['ecdsa-sha2-nistp384', ['ecdsa-sha2-nistp384']],
  ['ecdsa-sha2-nistp521', ['ecdsa-sha2-nistp521']],
  ['ssh-rsa', ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']],
]

export type PinnedHostKeyLookup =
  | { ok: true; fingerprint: string; keyType: string; hostKeyAlgorithms: string[] }
  | { ok: false; reason: 'no-file' | 'no-match' | 'ambiguous' }

/** The name OpenSSH looks up in known_hosts: lowercased host, `[host]:port` for a non-22 port. */
export function knownHostsLookupName(host: string, port: number): string {
  const name = host.toLowerCase()
  return port === DEFAULT_SSH_PORT ? name : `[${name}]:${port}`
}

/** OpenSSH SHA256 fingerprint (`SHA256:` + unpadded base64) of a public key blob. */
export function sshKeyFingerprint(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** OpenSSH `match_pattern`: `*` and `?` wildcards, case-insensitive. */
function matchPattern(name: string, pattern: string): boolean {
  const source = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${source}$`).test(name)
}

/** Hashed field `|1|salt|hash`: HMAC-SHA1 of the lookup name keyed with the salt. */
function matchHashed(field: string, name: string): boolean {
  const parts = field.split('|')
  if (parts.length !== 4) return false
  const salt = Buffer.from(parts[2], 'base64')
  const expected = Buffer.from(parts[3], 'base64')
  if (salt.length === 0 || expected.length !== 20) return false
  return timingSafeEqual(createHmac('sha1', salt).update(name).digest(), expected)
}

function hostFieldMatches(field: string, name: string): boolean {
  if (field.startsWith('|')) return matchHashed(field, name)
  let matched = false
  for (const entry of field.split(',')) {
    const negated = entry.startsWith('!')
    const pattern = negated ? entry.slice(1) : entry
    if (!pattern || !matchPattern(name, pattern)) continue
    if (negated) return false
    matched = true
  }
  return matched
}

/** Decode a base64 key blob whose embedded type string equals `keyType`; null if malformed. */
function parseKeyBlob(keyType: string, encoded: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null
  const blob = Buffer.from(encoded, 'base64')
  if (blob.length < 4) return null
  const typeLength = blob.readUInt32BE(0)
  if (4 + typeLength >= blob.length) return null
  return blob.toString('latin1', 4, 4 + typeLength) === keyType ? blob : null
}

/**
 * Find the key pinned for `host`/`port` in known_hosts `content`.
 *
 * Plain (`host`, `[host]:port`, comma lists with `*`/`?`/`!`) and hashed
 * (`|1|salt|hash`) host fields are supported. Comments, blank or malformed
 * lines and `@cert-authority` lines are ignored; a key listed under
 * `@revoked` (for any host) is never trusted. Identical keys recorded more
 * than once count once. When keys of several types are pinned the type ssh2
 * prefers is chosen (the caller restricts negotiation to it); two different
 * keys of that type are ambiguous.
 */
export function findPinnedHostKey(
  content: string,
  host: string,
  port: number,
): Exclude<PinnedHostKeyLookup, { reason: 'no-file' }> {
  const name = knownHostsLookupName(host, port)
  const revoked = new Set<string>()
  const candidates: Array<{ keyType: string; blob: Buffer }> = []

  for (const rawLine of content.split('\n')) {
    const lineText = rawLine.trim()
    if (!lineText || lineText.startsWith('#')) continue
    const fields = lineText.split(/\s+/)
    const marker = fields[0].startsWith('@') ? fields.shift() : undefined
    if (fields.length < 3) continue
    const [hostField, keyType, encoded] = fields
    const blob = parseKeyBlob(keyType, encoded)
    if (!blob) continue
    if (marker === '@revoked') {
      revoked.add(blob.toString('base64'))
      continue
    }
    if (marker !== undefined) continue
    if (hostFieldMatches(hostField, name)) candidates.push({ keyType, blob })
  }

  for (const [keyType, algorithms] of KEY_TYPE_ALGORITHMS) {
    const keys = new Set(
      candidates
        .filter((candidate) => candidate.keyType === keyType)
        .map((candidate) => candidate.blob.toString('base64'))
        .filter((encoded) => !revoked.has(encoded)),
    )
    if (keys.size === 0) continue
    if (keys.size > 1) return { ok: false, reason: 'ambiguous' }
    const [encoded] = keys
    return { ok: true, fingerprint: sshKeyFingerprint(Buffer.from(encoded, 'base64')), keyType, hostKeyAlgorithms: [...algorithms] }
  }
  return { ok: false, reason: 'no-match' }
}

/**
 * Read `filePath` (never creating it or its directory) and look up the key
 * pinned for `host`/`port`. A missing file is `no-file`; any other read error
 * (e.g. the path is a directory) is thrown.
 */
export async function readPinnedHostKey(filePath: string, host: string, port: number): Promise<PinnedHostKeyLookup> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'no-file' }
    throw error
  }
  return findPinnedHostKey(content, host, port)
}
