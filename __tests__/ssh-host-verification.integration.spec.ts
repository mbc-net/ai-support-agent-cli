import { createHash, generateKeyPairSync } from 'crypto'
import { Server, utils } from 'ssh2'
import { executeSshCommand } from '../src/commands/ssh-executor'
import { connectSshClient } from '../src/mcp/tools/db-tunnel'
import type { SshExecCredential } from '../src/types'

jest.mock('../src/logger')

/** Entirely local fake SSH peer: no production hosts or credentials. */
describe('SSH host-key verification before authentication', () => {
  let server: Server
  let port: number
  let authenticated: number
  let fingerprint: string
  const sockets = new Set<{ end(): void }>()

  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
    const parsed = utils.parseKey(privateKey)
    if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Test key parse failed')
    fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
    server = new Server({ hostKeys: [privateKey] }, (client) => {
      sockets.add(client)
      client.on('error', () => {})
      client.on('close', () => sockets.delete(client))
      client.on('authentication', (ctx) => { authenticated++; ctx.accept() })
      client.on('ready', () => client.on('session', (accept) => {
        accept().on('exec', (acceptExec) => { const stream = acceptExec(); stream.exit(0); stream.end('verified peer') })
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  beforeEach(() => { authenticated = 0 })
  afterAll(async () => {
    for (const socket of sockets) socket.end()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const credential = (pin: string): SshExecCredential => ({ hostId: 'local-fixture', hostname: '127.0.0.1', port, username: 'fixture', authType: 'password', privateKey: 'fixture-only', hostKeyFingerprint: pin })

  it('refuses a changed host key before sending a password for SSH commands', async () => {
    await expect(executeSshCommand(credential('SHA256:' + 'A'.repeat(43)), 'test', 3)).rejects.toThrow(/Host denied/)
    expect(authenticated).toBe(0)
  })
  it('refuses a changed host key before DB/RDP tunnel authentication', async () => {
    await expect(connectSshClient(credential('SHA256:' + 'A'.repeat(43)))).rejects.toThrow(/Host denied/)
    expect(authenticated).toBe(0)
  })
  it('runs commands only when the peer presents the pinned key', async () => {
    await expect(executeSshCommand(credential(fingerprint), 'test', 3)).resolves.toBe('verified peer')
    expect(authenticated).toBeGreaterThan(0)
  })
})
