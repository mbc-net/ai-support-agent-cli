import { generateKeyPairSync, sign } from 'crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { verifyLease, exportEnv, validateValues, VaultClient } from '../src/vault/runtime'

describe('vault runtime security', () => {
  const scope = { tenantCode: 'tenant', projectCode: 'project', serviceCode: 'api', environment: 'local' }
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  function lease(extra = {}) {
    const payload = Buffer.from(JSON.stringify({ ...scope, id: 'id', subject: 'subject', releaseId: 'release', digest: 'digest', issuedAt: Date.now(), expiresAt: Date.now() + 60000, ...extra })).toString('base64url')
    return `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString('base64url')}`
  }
  it('verifies subject, scope, release, expiry and signature', () => {
    expect(verifyLease(lease(), publicKey, scope, 'subject', 'release', 'digest').releaseId).toBe('release')
    for (const token of [lease({ subject: 'other' }), lease({ tenantCode: 'other' }), lease({ expiresAt: 0 }), lease({ releaseId: 'other' }), lease() + 'x']) {
      expect(() => verifyLease(token, publicKey, scope, 'subject', 'release', 'digest')).toThrow()
    }
  })
  it('refuses injected process-control and public secret variables', () => {
    expect(() => validateValues({ NODE_OPTIONS: '--require evil' }, [{ name: 'NODE_OPTIONS', secret: true }])).toThrow()
    expect(() => validateValues({ NEXT_PUBLIC_KEY: 'secret' }, [{ name: 'NEXT_PUBLIC_KEY', secret: true }])).toThrow()
  })
  it('requires the exact declared variables', () => {
    expect(() => validateValues({ A: 'a', B: 'b' }, [{ name: 'A', secret: false }])).toThrow()
    expect(() => validateValues({}, [{ name: 'A', secret: true }])).toThrow()
  })
  it('exports only ignored files, with restrictive permissions, and never overwrites', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-env-test-'))
    const file = join(dir, '.env.local')
    await expect(exportEnv(file, { PASSWORD: 'a\nb#c' }, async () => false)).rejects.toThrow()
    await exportEnv(file, { PASSWORD: 'a\nb#c' }, async () => true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).toContain('PASSWORD=')
    await expect(exportEnv(file, { PASSWORD: 'replacement' }, async () => true)).rejects.toThrow()
    expect(readFileSync(file, 'utf8')).not.toContain('replacement')
    writeFileSync(join(dir, 'tracked'), 'existing')
  })
  it('allows only a valid signed nonsecret cache on transient outages, never on denial', async () => {
    const originalFetch = global.fetch
    const cache = join(mkdtempSync(join(tmpdir(), 'vault-lease-')), 'lease.json')
    const bundle = { releaseId: 'release', digest: 'digest', variables: [], lease: { token: lease() }, region: 'ap-northeast-1', secretId: 'arn', versionId: 'version' }
    const client = new VaultClient('https://api.example.test', scope, 'vault:tenant:project:api:local:subject:credential', publicKey, undefined, cache)
    try {
      global.fetch = jest.fn().mockResolvedValue(new Response(JSON.stringify(bundle), { status: 200 }))
      await client.request('lease')
      expect(readFileSync(cache, 'utf8')).not.toContain('values')
      expect(statSync(cache).mode & 0o777).toBe(0o600)
      global.fetch = jest.fn().mockResolvedValue(new Response('', { status: 503 }))
      expect((await client.request('lease')).releaseId).toBe('release')
      await expect(client.request('lease', 'other')).rejects.toThrow()
      global.fetch = jest.fn().mockResolvedValue(new Response('', { status: 403 }))
      await expect(client.request('lease')).rejects.toThrow('403')
      global.fetch = jest.fn().mockResolvedValue(new Response('', { status: 503 }))
      writeFileSync(cache, JSON.stringify({ ...bundle, lease: { token: lease({ expiresAt: 0 }) } }))
      await expect(client.request('lease')).rejects.toThrow('expired')
    } finally { global.fetch = originalFetch }
  })

})
