import { generateKeyPairSync, sign } from 'crypto'
import { createServer, Server } from 'http'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { VaultClient, runWithVault } from '../src/vault/runtime'

describe('vault CLI process supervision', () => {
  const scope = { tenantCode: 'tenant', projectCode: 'project', serviceCode: 'api', environment: 'local' }
  const credential = 'vault:tenant:project:api:local:subject:credential'
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  let server: Server; let url: string; let rejectRenewal = false; let unavailable = false
  beforeEach(async () => {
    rejectRenewal = false; unavailable = false
    let count = 0
    server = createServer((req, res) => {
      req.resume()
      if (req.headers.authorization !== `Bearer ${credential}`) { res.writeHead(403).end(); return }
      count++
      if (rejectRenewal && count > 1) { res.writeHead(unavailable ? 503 : 403).end(); return }
      const claims = { ...scope, id: 'lease', subject: 'subject', releaseId: 'release', digest: 'digest', issuedAt: Date.now(), expiresAt: Date.now() + 3000 }
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ releaseId: 'release', digest: 'digest', variables: [{ name: 'PASSWORD', secret: true, type: 'string', required: true }], values: { PASSWORD: 'synthetic-secret' }, lease: { claims, token: `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString('base64url')}` } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
  it('injects values without passing them in argv and propagates a fast exit code', async () => {
    const client = new VaultClient(url, scope, credential, publicKey)
    const dir = mkdtempSync(join(tmpdir(), 'vault-process-'))
    const file = join(dir, 'result.json')
    const script = `require('fs').writeFileSync(process.argv[1], JSON.stringify({ password: process.env.PASSWORD, argv: process.argv })); process.exit(7)`
    expect(await runWithVault(client, [process.execPath, '-e', script, file])).toBe(7)
    const result = JSON.parse(readFileSync(file, 'utf8'))
    expect(result.password).toBe('synthetic-secret')
    expect(result.argv.join(' ')).not.toContain('synthetic-secret')
  })
  it('terminates a running process when renewal is explicitly denied', async () => {
    rejectRenewal = true
    const client = new VaultClient(url, scope, credential, publicKey)
    expect(await runWithVault(client, [process.execPath, '-e', 'setInterval(() => {}, 1000)'])).toBe(143)
  })
  it('tolerates central 5xx only until the signed lease expires', async () => {
    rejectRenewal = true; unavailable = true
    const client = new VaultClient(url, scope, credential, publicKey)
    const started = Date.now()
    expect(await runWithVault(client, [process.execPath, '-e', 'setInterval(() => {}, 1000)'])).toBe(143)
    expect(Date.now() - started).toBeGreaterThanOrEqual(2900)
  })
  it('does not stop an offline workload merely because its startup report is unavailable', async () => {
    const claims = { ...scope, id: 'lease', subject: 'subject', releaseId: 'release', digest: 'digest', issuedAt: Date.now(), expiresAt: Date.now() + 10000 }
    const bundle = { releaseId: 'release', digest: 'digest', variables: [{ name: 'PASSWORD', secret: true }], lease: { claims } }
    const client = { request: jest.fn(async (operation: string) => { if (operation === 'applied') throw new Error('Vault request rejected (503)'); return bundle }), materialize: async () => ({ PASSWORD: 'synthetic-secret' }) } as unknown as VaultClient
    expect(await runWithVault(client, [process.execPath, '-e', 'setTimeout(() => process.exit(7), 100)'], true)).toBe(7)
  })

  it('retries a transient startup report after recovery even before lease renewal', async () => {
    const claims = { ...scope, id: 'lease', subject: 'subject', releaseId: 'release', digest: 'digest', issuedAt: Date.now(), expiresAt: Date.now() + 60000 }
    const bundle = { releaseId: 'release', digest: 'digest', variables: [], lease: { claims } }
    let reports = 0
    const client = { request: jest.fn(async (operation: string) => {
      if (operation === 'applied' && ++reports === 1) throw new Error('Vault request rejected (503)')
      return bundle
    }), materialize: async () => ({}) } as unknown as VaultClient
    expect(await runWithVault(client, [process.execPath, '-e', 'setTimeout(() => process.exit(7), 2500)'], true)).toBe(7)
    expect(reports).toBe(2)
    expect(client.request).toHaveBeenLastCalledWith('applied', 'release')
  })

  it('stops when a retried startup report is explicitly denied', async () => {
    const claims = { ...scope, id: 'lease', subject: 'subject', releaseId: 'release', digest: 'digest', issuedAt: Date.now(), expiresAt: Date.now() + 60000 }
    const bundle = { releaseId: 'release', digest: 'digest', variables: [], lease: { claims } }
    let reports = 0
    const client = { request: jest.fn(async (operation: string) => {
      if (operation === 'applied') throw new Error(`Vault request rejected (${++reports === 1 ? 503 : 403})`)
      return bundle
    }), materialize: async () => ({}) } as unknown as VaultClient
    expect(await runWithVault(client, [process.execPath, '-e', 'setInterval(() => {}, 1000)'], true)).toBe(143)
    expect(reports).toBe(2)
  })

  it('stops descendants even if the parent exits normally', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'vault-descendants-')), 'pid')
    const script = `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync(process.argv[1],String(c.pid)); c.unref(); setTimeout(()=>process.exit(7),100)`
    const client = new VaultClient(url, scope, credential, publicKey)
    expect(await runWithVault(client, [process.execPath, '-e', script, file])).toBe(7)
    const pid = Number(readFileSync(file, 'utf8'))
    let alive = true
    for (let i = 0; i < 20 && alive; i++) {
      await new Promise(resolve => setTimeout(resolve, 25))
      try { process.kill(pid, 0) } catch { alive = false }
    }
    if (alive) { try { process.kill(pid, 'SIGKILL') } catch {} }
    expect(alive).toBe(false)
  })

})
