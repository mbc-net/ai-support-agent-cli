import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import type { ApiClient } from '../src/api-client'
import type { SshCredentials } from '../src/types'

jest.mock('fs')
jest.mock('os')
jest.mock('../src/logger')

const mockedFs = fs as jest.Mocked<typeof fs>
const mockedOs = os as jest.Mocked<typeof os>

import { setupSshConfig, cleanupSshConfig, buildManagedBlock, removeManagedBlock } from '../src/ssh-config-setup'

function createMockCredentials(hostId: string, overrides?: Partial<SshCredentials>): SshCredentials {
  return {
    hostId,
    hostname: `${hostId}.example.com`,
    port: 22,
    username: 'deploy',
    authType: 'private_key',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/yGaX\n-----END RSA PRIVATE KEY-----\n',
    ...overrides,
  }
}

function createMockClient(credentialsMap: Record<string, SshCredentials>): ApiClient {
  return {
    getSshCredentials: jest.fn().mockImplementation((hostId: string) => {
      const creds = credentialsMap[hostId]
      if (!creds) return Promise.reject(new Error(`Credentials not found for ${hostId}`))
      return Promise.resolve(creds)
    }),
  } as unknown as ApiClient
}

describe('ssh-config-setup', () => {
  const fakeHome = '/home/testuser'

  beforeEach(() => {
    jest.clearAllMocks()
    mockedOs.homedir.mockReturnValue(fakeHome)
    mockedFs.existsSync.mockReturnValue(false)
    mockedFs.writeFileSync.mockImplementation(() => {})
    mockedFs.mkdirSync.mockImplementation(() => '' as unknown as string)
    mockedFs.readFileSync.mockReturnValue('')
    mockedFs.readdirSync.mockReturnValue([])
    mockedFs.unlinkSync.mockImplementation(() => {})
  })

  describe('setupSshConfig', () => {
    it('should create ~/.ssh directory if it does not exist', async () => {
      const client = createMockClient({
        'host-1': createMockCredentials('host-1'),
      })

      mockedFs.existsSync.mockReturnValue(false)

      await setupSshConfig(client, {
        hosts: [{ hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' }],
      })

      expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
        path.join(fakeHome, '.ssh'),
        { recursive: true, mode: 0o700 },
      )
    })

    it('should not create ~/.ssh directory if it already exists', async () => {
      const client = createMockClient({
        'host-1': createMockCredentials('host-1'),
      })

      // First call: check ~/.ssh dir exists -> true
      // Second call: check ~/.ssh/config exists -> false
      mockedFs.existsSync.mockImplementation((p) => {
        if (p === path.join(fakeHome, '.ssh')) return true
        return false
      })

      await setupSshConfig(client, {
        hosts: [{ hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' }],
      })

      expect(mockedFs.mkdirSync).not.toHaveBeenCalled()
    })

    it('should write private key file with mode 0o600', async () => {
      const creds = createMockCredentials('host-1')
      const client = createMockClient({ 'host-1': creds })

      mockedFs.existsSync.mockImplementation((p) => {
        if (p === path.join(fakeHome, '.ssh')) return true
        return false
      })

      await setupSshConfig(client, {
        hosts: [{ hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' }],
      })

      expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
        path.join(fakeHome, '.ssh', 'ai-support-agent-host-1'),
        creds.privateKey,
        { mode: 0o600 },
      )
    })

    it('should normalize PEM key before writing', async () => {
      const rawKey = '-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn-----END RSA PRIVATE KEY-----'
      const creds = createMockCredentials('host-1', { privateKey: rawKey })
      const client = createMockClient({ 'host-1': creds })

      mockedFs.existsSync.mockImplementation((p) => {
        if (p === path.join(fakeHome, '.ssh')) return true
        return false
      })

      await setupSshConfig(client, {
        hosts: [{ hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' }],
      })

      // The key file should contain normalized PEM (with newlines)
      const writeCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => (call[0] as string).includes('ai-support-agent-host-1'),
      )
      expect(writeCall).toBeDefined()
      const writtenKey = writeCall![1] as string
      expect(writtenKey).toContain('\n')
      expect(writtenKey).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n/)
      expect(writtenKey).toMatch(/\n-----END RSA PRIVATE KEY-----\n$/)
    })

    it('should write SSH config with managed block', async () => {
      const client = createMockClient({
        'host-1': createMockCredentials('host-1'),
      })

      mockedFs.existsSync.mockImplementation((p) => {
        if (p === path.join(fakeHome, '.ssh')) return true
        return false
      })

      await setupSshConfig(client, {
        hosts: [{ hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' }],
      })

      const configWriteCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => (call[0] as string) === path.join(fakeHome, '.ssh', 'config'),
      )
      expect(configWriteCall).toBeDefined()
      const configContent = configWriteCall![1] as string
      expect(configContent).toContain('# BEGIN ai-support-agent managed')
      expect(configContent).toContain('# END ai-support-agent managed')
      expect(configContent).toContain('Host ai-agent-host-1')
      expect(configContent).toContain('HostName host-1.example.com')
      expect(configContent).toContain('Port 22')
      expect(configContent).toContain('User deploy')
      expect(configContent).toContain('IdentityFile ~/.ssh/ai-support-agent-host-1')
      expect(configContent).toContain('StrictHostKeyChecking no')
      expect(configContent).toContain('UserKnownHostsFile /dev/null')
    })

    it('should handle multiple hosts', async () => {
      const client = createMockClient({
        'host-1': createMockCredentials('host-1'),
        'host-2': createMockCredentials('host-2', { port: 2222, username: 'admin' }),
      })

      mockedFs.existsSync.mockImplementation((p) => {
        if (p === path.join(fakeHome, '.ssh')) return true
        return false
      })

      await setupSshConfig(client, {
        hosts: [
          { hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' },
          { hostId: 'host-2', name: 'Host 2', hostname: 'host-2.example.com', port: 2222, username: 'admin', authType: 'private_key' },
        ],
      })

      const configWriteCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => (call[0] as string) === path.join(fakeHome, '.ssh', 'config'),
      )
      expect(configWriteCall).toBeDefined()
      const configContent = configWriteCall![1] as string
      expect(configContent).toContain('Host ai-agent-host-1')
      expect(configContent).toContain('Host ai-agent-host-2')
      expect(configContent).toContain('Port 2222')
      expect(configContent).toContain('User admin')
    })

    it('should preserve existing SSH config outside managed block', async () => {
      const existingConfig = 'Host myserver\n    HostName myserver.com\n    User me\n'
      const client = createMockClient({
        'host-1': createMockCredentials('host-1'),
      })

      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(existingConfig)

      await setupSshConfig(client, {
        hosts: [{ hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' }],
      })

      const configWriteCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => (call[0] as string) === path.join(fakeHome, '.ssh', 'config'),
      )
      expect(configWriteCall).toBeDefined()
      const configContent = configWriteCall![1] as string
      expect(configContent).toContain('Host myserver')
      expect(configContent).toContain('HostName myserver.com')
      expect(configContent).toContain('# BEGIN ai-support-agent managed')
    })

    it('should replace existing managed block', async () => {
      const existingConfig = [
        'Host myserver',
        '    HostName myserver.com',
        '',
        '# BEGIN ai-support-agent managed',
        'Host ai-agent-old-host',
        '    HostName old.example.com',
        '# END ai-support-agent managed',
        '',
      ].join('\n')

      const client = createMockClient({
        'host-new': createMockCredentials('host-new'),
      })

      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(existingConfig)

      await setupSshConfig(client, {
        hosts: [{ hostId: 'host-new', name: 'Host New', hostname: 'host-new.example.com', port: 22, username: 'deploy', authType: 'private_key' }],
      })

      const configWriteCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => (call[0] as string) === path.join(fakeHome, '.ssh', 'config'),
      )
      expect(configWriteCall).toBeDefined()
      const configContent = configWriteCall![1] as string
      expect(configContent).not.toContain('old-host')
      expect(configContent).toContain('Host ai-agent-host-new')
      // Should contain exactly one managed block
      expect(configContent.match(/# BEGIN ai-support-agent managed/g)).toHaveLength(1)
      expect(configContent.match(/# END ai-support-agent managed/g)).toHaveLength(1)
    })

    it('should handle individual host failure gracefully', async () => {
      const client = createMockClient({
        'host-2': createMockCredentials('host-2'),
      })
      // host-1 will fail (not in credentialsMap)

      mockedFs.existsSync.mockImplementation((p) => {
        if (p === path.join(fakeHome, '.ssh')) return true
        return false
      })

      await setupSshConfig(client, {
        hosts: [
          { hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' },
          { hostId: 'host-2', name: 'Host 2', hostname: 'host-2.example.com', port: 22, username: 'deploy', authType: 'private_key' },
        ],
      })

      // host-2 should still be configured
      const configWriteCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => (call[0] as string) === path.join(fakeHome, '.ssh', 'config'),
      )
      expect(configWriteCall).toBeDefined()
      const configContent = configWriteCall![1] as string
      expect(configContent).not.toContain('Host ai-agent-host-1')
      expect(configContent).toContain('Host ai-agent-host-2')
    })

    it('should handle writeSshConfig failure gracefully', async () => {
      const client = createMockClient({
        'host-1': createMockCredentials('host-1'),
      })

      mockedFs.existsSync.mockImplementation((p) => {
        if (p === path.join(fakeHome, '.ssh')) return true
        return false
      })

      // Make writeFileSync throw only for the config file (not the key file)
      let keyWritten = false
      mockedFs.writeFileSync.mockImplementation(((filePath: string) => {
        if ((filePath as string).endsWith('config')) {
          throw new Error('ENOSPC: no space left on device')
        }
        keyWritten = true
      }) as any)

      // Should not throw
      await expect(setupSshConfig(client, {
        hosts: [{ hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' }],
      })).resolves.toBeUndefined()

      // Key file was written before config failed
      expect(keyWritten).toBe(true)
    })

    it('should not write config when all hosts fail', async () => {
      const client = createMockClient({})

      mockedFs.existsSync.mockImplementation((p) => {
        if (p === path.join(fakeHome, '.ssh')) return true
        return false
      })

      await setupSshConfig(client, {
        hosts: [
          { hostId: 'host-1', name: 'Host 1', hostname: 'host-1.example.com', port: 22, username: 'deploy', authType: 'private_key' },
        ],
      })

      const configWriteCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => (call[0] as string) === path.join(fakeHome, '.ssh', 'config'),
      )
      expect(configWriteCall).toBeUndefined()
    })
  })

  describe('cleanupSshConfig', () => {
    it('should remove managed block from SSH config', () => {
      const existingConfig = [
        'Host myserver',
        '    HostName myserver.com',
        '',
        '# BEGIN ai-support-agent managed',
        'Host ai-agent-host-1',
        '    HostName host-1.example.com',
        '# END ai-support-agent managed',
      ].join('\n')

      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(existingConfig)
      mockedFs.readdirSync.mockReturnValue([])

      cleanupSshConfig()

      const configWriteCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => (call[0] as string) === path.join(fakeHome, '.ssh', 'config'),
      )
      expect(configWriteCall).toBeDefined()
      const configContent = configWriteCall![1] as string
      expect(configContent).toContain('Host myserver')
      expect(configContent).not.toContain('# BEGIN ai-support-agent managed')
      expect(configContent).not.toContain('ai-agent-host-1')
    })

    it('should remove ai-support-agent key files', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue('')
      mockedFs.readdirSync.mockReturnValue([
        'id_rsa',
        'ai-support-agent-host-1',
        'ai-support-agent-host-2',
        'config',
      ] as any)

      cleanupSshConfig()

      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        path.join(fakeHome, '.ssh', 'ai-support-agent-host-1'),
      )
      expect(mockedFs.unlinkSync).toHaveBeenCalledWith(
        path.join(fakeHome, '.ssh', 'ai-support-agent-host-2'),
      )
      expect(mockedFs.unlinkSync).toHaveBeenCalledTimes(2)
    })

    it('should handle missing config file gracefully', () => {
      mockedFs.existsSync.mockImplementation((p) => {
        if ((p as string).endsWith('config')) return false
        return true
      })
      mockedFs.readdirSync.mockReturnValue([])

      expect(() => cleanupSshConfig()).not.toThrow()
    })

    it('should handle missing .ssh directory gracefully', () => {
      mockedFs.existsSync.mockReturnValue(false)

      expect(() => cleanupSshConfig()).not.toThrow()
      expect(mockedFs.readdirSync).not.toHaveBeenCalled()
    })

    it('should handle errors when removing key files', () => {
      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue('')
      mockedFs.readdirSync.mockReturnValue([
        'ai-support-agent-host-1',
      ] as any)
      mockedFs.unlinkSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied')
      })

      expect(() => cleanupSshConfig()).not.toThrow()
    })

    it('should write empty string when config only had managed block', () => {
      const configContent = [
        '# BEGIN ai-support-agent managed',
        'Host ai-agent-host-1',
        '    HostName host-1.example.com',
        '# END ai-support-agent managed',
      ].join('\n')

      mockedFs.existsSync.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(configContent)
      mockedFs.readdirSync.mockReturnValue([])

      cleanupSshConfig()

      const configWriteCall = mockedFs.writeFileSync.mock.calls.find(
        (call) => (call[0] as string) === path.join(fakeHome, '.ssh', 'config'),
      )
      expect(configWriteCall).toBeDefined()
      expect(configWriteCall![1]).toBe('')
    })
  })

  describe('buildManagedBlock', () => {
    it('should build correct managed block for single entry', () => {
      const block = buildManagedBlock([
        { hostId: 'host-1', hostname: 'server.example.com', port: 22, username: 'deploy' },
      ])

      expect(block).toBe([
        '# BEGIN ai-support-agent managed',
        'Host ai-agent-host-1',
        '    HostName server.example.com',
        '    Port 22',
        '    User deploy',
        '    IdentityFile ~/.ssh/ai-support-agent-host-1',
        '    StrictHostKeyChecking no',
        '    UserKnownHostsFile /dev/null',
        '# END ai-support-agent managed',
      ].join('\n'))
    })

    it('should build correct managed block for multiple entries', () => {
      const block = buildManagedBlock([
        { hostId: 'host-1', hostname: 'server1.example.com', port: 22, username: 'deploy' },
        { hostId: 'host-2', hostname: 'server2.example.com', port: 2222, username: 'admin' },
      ])

      expect(block).toContain('Host ai-agent-host-1')
      expect(block).toContain('Host ai-agent-host-2')
      expect(block).toContain('Port 2222')
      expect(block).toContain('User admin')
      expect(block.startsWith('# BEGIN ai-support-agent managed')).toBe(true)
      expect(block.endsWith('# END ai-support-agent managed')).toBe(true)
    })
  })

  describe('removeManagedBlock', () => {
    it('should remove managed block from content', () => {
      const content = [
        'Host myserver',
        '    HostName myserver.com',
        '',
        '# BEGIN ai-support-agent managed',
        'Host ai-agent-host-1',
        '    HostName host-1.example.com',
        '# END ai-support-agent managed',
        '',
        'Host otherserver',
        '    HostName other.com',
      ].join('\n')

      const result = removeManagedBlock(content)
      expect(result).not.toContain('# BEGIN ai-support-agent managed')
      expect(result).not.toContain('ai-agent-host-1')
      expect(result).toContain('Host myserver')
      expect(result).toContain('Host otherserver')
    })

    it('should return content unchanged when no managed block exists', () => {
      const content = 'Host myserver\n    HostName myserver.com\n'
      expect(removeManagedBlock(content)).toBe(content)
    })

    it('should return content unchanged when only BEGIN marker exists', () => {
      const content = 'Host myserver\n# BEGIN ai-support-agent managed\nHost ai-agent-x\n'
      expect(removeManagedBlock(content)).toBe(content)
    })

    it('should handle empty content', () => {
      expect(removeManagedBlock('')).toBe('')
    })

    it('should collapse multiple blank lines after removal', () => {
      const content = [
        'Host myserver',
        '',
        '',
        '# BEGIN ai-support-agent managed',
        'Host ai-agent-host-1',
        '# END ai-support-agent managed',
        '',
        '',
        '',
        'Host other',
      ].join('\n')

      const result = removeManagedBlock(content)
      expect(result).not.toMatch(/\n{3,}/)
    })
  })
})
