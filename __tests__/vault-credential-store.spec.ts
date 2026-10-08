import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { CredentialStore } from '../src/vault/credential-store'
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), spawn: jest.fn() }))
const login = { token: 'vault:tenant:project:api:local:subject:synthetic-credential', publicKey: 'synthetic-public-key', expiresAt: Date.now() + 60000 }
const inputs: string[] = []
function response(output = '', code = 0) {
  const child = Object.assign(new EventEmitter(), { stdin: { end: (input: string) => { inputs.push(input); queueMicrotask(() => { child.stdout.end(output); child.stderr.end(''); child.emit('exit', code) }) } }, stdout: new PassThrough(), stderr: new PassThrough(), kill: jest.fn() })
  return child
}
beforeEach(() => { jest.clearAllMocks(); inputs.length = 0 })
it('stores credentials through stdin and verifies the OS-store result', async () => {
  ;(spawn as jest.Mock).mockReturnValueOnce(response()).mockReturnValueOnce(response(JSON.stringify(login)))
  await new CredentialStore().save('account-id', login)
  expect(JSON.stringify((spawn as jest.Mock).mock.calls)).not.toContain(login.token)
  expect(inputs[0]).toContain(login.token)
  expect((spawn as jest.Mock).mock.calls).toHaveLength(2)
})
it('does not claim success when an interactive store returns no stored credential', async () => {
  ;(spawn as jest.Mock).mockReturnValueOnce(response()).mockReturnValueOnce(response('', 1))
  await expect(new CredentialStore().save('account-id', login)).rejects.toThrow('OS credential')
})
it('sanitizes OS command failures and allows reading expired credentials only for cleanup', async () => {
  ;(spawn as jest.Mock).mockReturnValueOnce(response(login.token, 1))
  await expect(new CredentialStore().load('account-id')).rejects.toThrow('OS credential store operation failed')
  const expired = { ...login, expiresAt: 1 }
  ;(spawn as jest.Mock).mockReturnValueOnce(response(JSON.stringify(expired))).mockReturnValueOnce(response(JSON.stringify(expired)))
  await expect(new CredentialStore().load('account-id')).rejects.toThrow('expired')
  expect(await new CredentialStore().load('account-id', true)).toEqual(expired)
})
