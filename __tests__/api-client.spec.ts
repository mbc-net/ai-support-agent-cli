import axios from 'axios'

import { ApiClient } from '../src/api-client'
import { logger } from '../src/logger'
import { createAxiosError } from './helpers/mock-factory'

jest.mock('axios')
jest.mock('../src/logger')
const mockedAxios = axios as jest.Mocked<typeof axios>
const mockedLogger = logger as jest.Mocked<typeof logger>

describe('ApiClient', () => {
  let client: ApiClient
  const mockInstance = {
    post: jest.fn(),
    get: jest.fn(),
    put: jest.fn(),
    defaults: { headers: {} as Record<string, string> },
  }

  beforeEach(() => {
    mockedAxios.create.mockReturnValue(mockInstance as any)
    client = new ApiClient('http://localhost:3030', 'test_tenant:tokenId:rawToken')
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
    jest.restoreAllMocks()
  })

  describe('setTenantCode', () => {
    it('should update the tenant code used in API paths', async () => {
      mockInstance.get.mockResolvedValue({ data: {} })
      client.setTenantCode('new_tenant')
      await client.getConfig()
      expect(mockInstance.get).toHaveBeenCalledWith('/api/new_tenant/agent/config', undefined)
    })
  })

  describe('getTenantCode', () => {
    it('returns the tenant code extracted from the token by default', () => {
      expect(client.getTenantCode()).toBe('test_tenant')
    })

    it('reflects a later setTenantCode override', () => {
      client.setTenantCode('other_tenant')
      expect(client.getTenantCode()).toBe('other_tenant')
    })
  })

  describe('setProjectCode', () => {
    it('should update the project code used in file API paths', async () => {
      mockInstance.post.mockResolvedValue({
        data: { uploadUrl: 'https://s3.example.com/upload', fileId: 'file-1', s3Key: 'key' },
      })
      client.setProjectCode('PROJ_01')
      await client.getUploadUrl({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        filename: 'test.txt',
        contentType: 'text/plain',
        fileSize: 1024,
        projectCode: 'PROJ_01',
      })
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/projects/PROJ_01/agent/files/upload-url',
        expect.any(Object),
        undefined,
      )
    })
  })

  describe('getProjectConfig', () => {
    it('should fetch project config from server', async () => {
      const config = { projectCode: 'TEST_01', projectName: 'Test' }
      mockInstance.get.mockResolvedValue({ data: config })

      const result = await client.getProjectConfig()

      expect(result).toEqual(config)
      expect(mockInstance.get).toHaveBeenCalledWith('/api/test_tenant/agent/project-config', undefined)
    })
  })

  describe('updateToken', () => {
    it('should update the Authorization header on the axios instance', () => {
      const defaults = { headers: { Authorization: 'Bearer test_tenant:tokenId:rawToken' } }
      Object.defineProperty(mockInstance, 'defaults', {
        value: defaults,
        writable: true,
        configurable: true,
      })

      client.updateToken('new-token')
      expect(defaults.headers['Authorization']).toBe('Bearer new-token')
    })
  })

  describe('register', () => {
    it('should send registration request', async () => {
      mockInstance.post.mockResolvedValue({
        data: { agentId: 'test-id', appsyncUrl: '', appsyncApiKey: '' },
      })

      const result = await client.register({
        agentId: 'test-id',
        hostname: 'hostname',
        os: 'darwin',
        arch: 'arm64',
      })
      expect(result.agentId).toBe('test-id')
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/register',
        expect.objectContaining({ agentId: 'test-id', hostname: 'hostname' }),
        undefined,
      )
    })

    it('should include ipAddress, availableChatModes, and activeChatMode when provided', async () => {
      mockInstance.post.mockResolvedValue({
        data: { agentId: 'test-id', appsyncUrl: '', appsyncApiKey: '' },
      })

      await client.register({
        agentId: 'test-id',
        hostname: 'hostname',
        os: 'darwin',
        arch: 'arm64',
        ipAddress: '192.168.1.1',
        availableChatModes: ['claude_code', 'api'],
        activeChatMode: 'claude_code',
      })

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).toHaveProperty('ipAddress', '192.168.1.1')
      expect(callArgs).toHaveProperty('availableChatModes', ['claude_code', 'api'])
      expect(callArgs).toHaveProperty('activeChatMode', 'claude_code')
    })

    it('should not include ipAddress when not provided', async () => {
      mockInstance.post.mockResolvedValue({
        data: { agentId: 'test-id', appsyncUrl: '', appsyncApiKey: '' },
      })

      await client.register({
        agentId: 'test-id',
        hostname: 'hostname',
        os: 'darwin',
        arch: 'arm64',
      })

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).not.toHaveProperty('ipAddress')
      expect(callArgs).not.toHaveProperty('availableChatModes')
      expect(callArgs).not.toHaveProperty('activeChatMode')
    })
  })

  describe('heartbeat', () => {
    it('should send heartbeat', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      })

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/heartbeat',
        expect.objectContaining({ agentId: 'test-id' }),
        undefined,
      )
    })
  })

  describe('getVersionInfo', () => {
    it('should fetch version info from production API with default channel', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          latestVersion: '1.2.0',
          minimumVersion: '1.0.0',
          channel: 'latest',
          channels: { latest: '1.2.0' },
        },
      })

      const result = await client.getVersionInfo()
      expect(result.latestVersion).toBe('1.2.0')
      expect(result.channel).toBe('latest')
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.ai-support-agent.com/api/agent/version',
        expect.objectContaining({ params: { channel: 'latest' } }),
      )
    })

    it('should pass channel parameter to production API', async () => {
      mockedAxios.get.mockResolvedValue({
        data: {
          latestVersion: '1.3.0-beta.1',
          minimumVersion: '1.0.0',
          channel: 'beta',
          channels: { beta: '1.3.0-beta.1' },
        },
      })

      const result = await client.getVersionInfo('beta')
      expect(result.latestVersion).toBe('1.3.0-beta.1')
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.ai-support-agent.com/api/agent/version',
        expect.objectContaining({ params: { channel: 'beta' } }),
      )
    })

    it('should always use production API regardless of client baseURL', async () => {
      // Client is configured with dev URL
      const devClient = new ApiClient('https://dev-api.ai-support-agent.com', 'test_tenant:tokenId:rawToken')
      mockedAxios.get.mockResolvedValue({
        data: {
          latestVersion: '1.2.0',
          minimumVersion: '1.0.0',
          channel: 'latest',
          channels: { latest: '1.2.0' },
        },
      })

      await devClient.getVersionInfo()
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.ai-support-agent.com/api/agent/version',
        expect.objectContaining({ params: { channel: 'latest' } }),
      )
    })
  })

  describe('heartbeat with updateError', () => {
    it('should include updateError when provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      }, 'EACCES: permission denied')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/heartbeat',
        expect.objectContaining({
          agentId: 'test-id',
          updateError: 'EACCES: permission denied',
        }),
        undefined,
      )
    })

    it('should not include updateError when not provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      })

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).not.toHaveProperty('updateError')
    })

    it('should include availableChatModes and activeChatMode when provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      }, undefined, ['claude_code', 'api'], 'claude_code')

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).toHaveProperty('availableChatModes', ['claude_code', 'api'])
      expect(callArgs).toHaveProperty('activeChatMode', 'claude_code')
    })

    it('should not include availableChatModes and activeChatMode when not provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      })

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).not.toHaveProperty('availableChatModes')
      expect(callArgs).not.toHaveProperty('activeChatMode')
    })

    it('should include ipAddress, configHash, dockerBuildError when provided (line 134-136)', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat(
        'test-id',
        { platform: 'darwin', arch: 'arm64', cpuUsage: 50, memoryUsage: 60, uptime: 1000 },
        undefined,       // updateError
        undefined,       // availableChatModes
        undefined,       // activeChatMode
        '10.0.0.1',      // ipAddress — truthy branch line 134
        'abc123',        // configHash — truthy branch line 135
        'build failed',  // dockerBuildError — truthy branch line 136
      )

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).toHaveProperty('ipAddress', '10.0.0.1')
      expect(callArgs).toHaveProperty('configHash', 'abc123')
      expect(callArgs).toHaveProperty('dockerBuildError', 'build failed')
    })

    it('should include authRejectedTransports when provided (even an empty array, to clear a stale flag)', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat(
        'test-id',
        { platform: 'darwin', arch: 'arm64', cpuUsage: 50, memoryUsage: 60, uptime: 1000 },
        undefined, // updateError
        undefined, // availableChatModes
        undefined, // activeChatMode
        undefined, // ipAddress
        undefined, // configHash
        undefined, // dockerBuildError
        ['terminal', 'vscode'], // authRejectedTransports
      )

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).toHaveProperty('authRejectedTransports', ['terminal', 'vscode'])
    })

    it('should not include authRejectedTransports when not provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.heartbeat('test-id', {
        platform: 'darwin',
        arch: 'arm64',
        cpuUsage: 50,
        memoryUsage: 60,
        uptime: 1000,
      })

      const callArgs = mockInstance.post.mock.calls[0][1]
      expect(callArgs).not.toHaveProperty('authRejectedTransports')
    })
  })

  describe('getPendingCommands', () => {
    it('should fetch pending commands', async () => {
      mockInstance.get.mockResolvedValue({
        data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
      })

      const result = await client.getPendingCommands('agent-1')
      expect(result).toHaveLength(1)
      expect(result[0].commandId).toBe('cmd-1')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/test_tenant/agent/commands/pending',
        { params: { agentId: 'agent-1' } },
      )
    })
  })

  describe('getAwsCredentials', () => {
    it('should fetch AWS credentials for an account', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret...',
          sessionToken: 'token...',
          region: 'ap-northeast-1',
        },
      })

      const result = await client.getAwsCredentials('prod')
      expect(result.accessKeyId).toBe('AKIA...')
      expect(result.secretAccessKey).toBe('secret...')
      expect(result.sessionToken).toBe('token...')
      expect(result.region).toBe('ap-northeast-1')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/test_tenant/agent/aws-credentials',
        { params: { awsAccountId: 'prod' } },
      )
    })
  })

  describe('getDbCredentials', () => {
    it('should fetch DB credentials', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          name: 'MAIN',
          engine: 'mysql',
          host: 'db.local',
          port: 3306,
          database: 'testdb',
          user: 'admin',
          password: 'secret',
        },
      })

      const result = await client.getDbCredentials('MAIN')
      expect(result.name).toBe('MAIN')
      expect(result.engine).toBe('mysql')
      expect(result.password).toBe('secret')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/test_tenant/agent/db-credentials',
        { params: { name: 'MAIN' } },
      )
    })
  })

  describe('getSshCredentials', () => {
    it('should fetch SSH credentials for a host', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          hostId: 'host-1',
          hostname: 'server.example.com',
          port: 22,
          username: 'deploy',
          authType: 'private_key',
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
        },
      })

      const result = await client.getSshCredentials('host-1')
      expect(result.hostId).toBe('host-1')
      expect(result.hostname).toBe('server.example.com')
      expect(result.port).toBe(22)
      expect(result.username).toBe('deploy')
      expect(result.privateKey).toContain('BEGIN RSA PRIVATE KEY')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/test_tenant/agent/ssh-credentials/host-1',
        undefined,
      )
    })
  })

  describe('getSshExecCredential', () => {
    it('should fetch the ssh_exec JIT credential scoped to a commandId', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          hostId: 'host-1',
          hostname: 'server.example.com',
          port: 22,
          username: 'deploy',
          authType: 'private_key',
          privateKey: '-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----\n',
        },
      })

      const result = await client.getSshExecCredential('cmd-1', 'agent-1')
      expect(result.hostId).toBe('host-1')
      expect(result.hostname).toBe('server.example.com')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/test_tenant/agent/commands/cmd-1/ssh-exec-credential',
        { params: { agentId: 'agent-1' } },
      )
    })

    it('should tolerate a response carrying Tailscale SOCKS5 fields', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          hostId: 'host-2',
          hostname: 'unused.example.com',
          port: 22,
          username: 'deploy',
          authType: 'private_key',
          privateKey: 'key-material',
          connectionType: 'tailscale',
          tailnetHostname: 'db-server-1.tailxxxx.ts.net',
          socksPort: 1055,
        },
      })

      const result = await client.getSshExecCredential('cmd-2', 'agent-1')
      expect(result.connectionType).toBe('tailscale')
      expect(result.tailnetHostname).toBe('db-server-1.tailxxxx.ts.net')
      expect(result.socksPort).toBe(1055)
    })

    it('should reject an invalid commandId', async () => {
      await expect(client.getSshExecCredential('bad id!', 'agent-1')).rejects.toThrow(
        'Invalid command ID format',
      )
    })
  })

  describe('getRepoCredentials', () => {
    it('should fetch repo credentials', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          repositoryId: 'REPO_01',
          repositoryUrl: 'https://github.com/org/repo.git',
          authMethod: 'api_key',
          authSecret: 'ghp_token123',
        },
      })

      const result = await client.getRepoCredentials('REPO_01')
      expect(result.repositoryId).toBe('REPO_01')
      expect(result.repositoryUrl).toBe('https://github.com/org/repo.git')
      expect(result.authMethod).toBe('api_key')
      expect(result.authSecret).toBe('ghp_token123')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/test_tenant/agent/repo-credentials/REPO_01',
        undefined,
      )
    })
  })

  describe('getBrowserCredentials', () => {
    it('should fetch browser credentials by name', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          name: 'test-browser',
          loginUrl: 'https://example.com/login',
          username: 'user@example.com',
          password: 'secret123',
        },
      })

      const result = await client.getBrowserCredentials('test-browser')
      expect(result.name).toBe('test-browser')
      expect(result.loginUrl).toBe('https://example.com/login')
      expect(result.username).toBe('user@example.com')
      expect(result.password).toBe('secret123')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/test_tenant/agent/browser-credentials',
        { params: { name: 'test-browser' } },
      )
    })
  })

  describe('getE2eEnvironmentVariables', () => {
    it('should fetch E2E environment variables by environmentId and return the variables map', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          environmentId: 'env-1',
          variables: { API_TOKEN: 'tok-123', DB_PASSWORD: 's3cr3t' },
        },
      })

      const result = await client.getE2eEnvironmentVariables('env-1')
      expect(result).toEqual({ API_TOKEN: 'tok-123', DB_PASSWORD: 's3cr3t' })
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/test_tenant/agent/e2e-env-variables',
        { params: { environmentId: 'env-1' } },
      )
    })

    it('should return an empty object when no variables are registered', async () => {
      mockInstance.get.mockResolvedValue({
        data: { environmentId: 'env-2', variables: {} },
      })

      const result = await client.getE2eEnvironmentVariables('env-2')
      expect(result).toEqual({})
    })
  })

  describe('submitResult', () => {
    it('should submit command result', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true } })

      await client.submitResult('cmd-1', { success: true, data: 'output' }, 'agent-1')
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/commands/cmd-1/result',
        { success: true, data: 'output' },
        { params: { agentId: 'agent-1' } },
      )
    })
  })

  describe('registerEcsAgent', () => {
    it('should POST the registration to the ecs-agents endpoint', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      const registration = {
        agentId: 'ecs-uuid-1',
        displayName: 'My ECS Agent',
        capabilities: [],
        ecsConfig: {
          imageUri: '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/repo@sha256:abc',
          imageTag: 'v1',
          imageDigest: 'sha256:abc',
          cpu: 1024,
          memory: 2048,
          taskDefinitionArn: 'arn:aws:ecs:ap-northeast-1:123456789012:task-definition/fam:1',
          taskDefinitionFamily: 'fam',
          clusterArn: 'arn:aws:ecs:ap-northeast-1:123456789012:cluster/c',
          subnetIds: ['subnet-1'],
          securityGroupIds: ['sg-1'],
          logGroupName: '/ai-support-agent/ecs-agent',
          registeredBy: 'publisher-agent',
          registeredAt: '2026-01-01T00:00:00.000Z',
        },
      }
      await client.registerEcsAgent(registration)

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/ecs-agents',
        registration,
        undefined,
      )
    })
  })

  describe('getCommand', () => {
    it('should fetch a specific command by ID', async () => {
      mockInstance.get.mockResolvedValue({
        data: {
          commandId: 'cmd-1',
          type: 'execute_command',
          payload: { command: 'echo hello' },
          status: 'PENDING',
          createdAt: 1700000000000,
        },
      })

      const result = await client.getCommand('cmd-1', 'agent-1')
      expect(result.commandId).toBe('cmd-1')
      expect(result.type).toBe('execute_command')
      expect(mockInstance.get).toHaveBeenCalledWith(
        '/api/test_tenant/agent/commands/cmd-1',
        { params: { agentId: 'agent-1' } },
      )
    })
  })

  describe('commandId validation', () => {
    it('should reject commandId with path traversal', async () => {
      await expect(client.getCommand('../../admin', 'agent-1')).rejects.toThrow('Invalid command ID format')
    })

    it('should reject commandId with special characters', async () => {
      await expect(client.submitResult('cmd;drop', { success: true, data: '' }, 'agent-1')).rejects.toThrow('Invalid command ID format')
    })

    it('should reject commandId with slashes', async () => {
      await expect(client.getCommand('cmd/delete', 'agent-1')).rejects.toThrow('Invalid command ID format')
    })

    it('should accept valid commandId with alphanumeric, hyphens, and underscores', async () => {
      mockInstance.get.mockResolvedValue({
        data: { commandId: 'abc-123_DEF', type: 'execute_command', payload: {}, status: 'PENDING', createdAt: 0 },
      })

      const result = await client.getCommand('abc-123_DEF', 'agent-1')
      expect(result.commandId).toBe('abc-123_DEF')
    })
  })

  describe('HTTP URL restriction', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
      delete process.env.AI_SUPPORT_AGENT_ALLOW_HTTP
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should throw error when API URL uses HTTP with a remote host', () => {
      mockedAxios.create.mockReturnValue(mockInstance as any)
      expect(() => new ApiClient('http://remote-server:3000', 'test-token')).toThrow(
        'API URL uses HTTP (not HTTPS). Set AI_SUPPORT_AGENT_ALLOW_HTTP=true to allow insecure connections.',
      )
    })

    it('should warn instead of throwing when AI_SUPPORT_AGENT_ALLOW_HTTP=true', () => {
      process.env.AI_SUPPORT_AGENT_ALLOW_HTTP = 'true'
      mockedAxios.create.mockReturnValue(mockInstance as any)
      new ApiClient('http://remote-server:3000', 'test-token')
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'API URL uses HTTP (not HTTPS). Token may be transmitted in plain text.',
      )
    })

    it('should not warn or throw when API URL uses HTTPS', () => {
      mockedAxios.create.mockReturnValue(mockInstance as any)
      mockedLogger.warn.mockClear()
      new ApiClient('https://remote-server:3000', 'test-token')
      expect(mockedLogger.warn).not.toHaveBeenCalled()
    })

    it('should not warn or throw when API URL uses HTTP with 127.0.0.1', () => {
      mockedAxios.create.mockReturnValue(mockInstance as any)
      mockedLogger.warn.mockClear()
      new ApiClient('http://127.0.0.1:3030', 'test-token')
      expect(mockedLogger.warn).not.toHaveBeenCalled()
    })

    it('should not warn or throw when API URL uses HTTP with localhost', () => {
      mockedAxios.create.mockReturnValue(mockInstance as any)
      mockedLogger.warn.mockClear()
      new ApiClient('http://localhost:3030', 'test-token')
      expect(mockedLogger.warn).not.toHaveBeenCalled()
    })
  })

  describe('reportConnectionStatus', () => {
    it('should send connection status', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      await client.reportConnectionStatus('agent-1', 'connected')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/connection-status',
        expect.objectContaining({
          agentId: 'agent-1',
          status: 'connected',
          timestamp: expect.any(Number),
        }),
        undefined,
      )
    })

    it('should send disconnected status', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      await client.reportConnectionStatus('agent-1', 'disconnected')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/connection-status',
        expect.objectContaining({
          status: 'disconnected',
        }),
        undefined,
      )
    })
  })

  describe('getConfig', () => {
    it('should fetch agent config from server', async () => {
      const config = {
        agentEnabled: true,
        builtinAgentEnabled: true,
        builtinFallbackEnabled: false,
        externalAgentEnabled: true,
        chatMode: 'agent',
      }
      mockInstance.get.mockResolvedValue({ data: config })

      const result = await client.getConfig()

      expect(result).toEqual(config)
      expect(mockInstance.get).toHaveBeenCalledWith('/api/test_tenant/agent/config', undefined)
    })
  })

  describe('submitChatChunk', () => {
    it('should submit chat chunk with correct parameters', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      await client.submitChatChunk('cmd-1', {
        index: 0,
        type: 'delta',
        content: 'Hello',
      }, 'agent-1')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/commands/cmd-1/chunks',
        { index: 0, type: 'delta', content: 'Hello' },
        { params: { agentId: 'agent-1' } },
      )
    })

    it('should validate commandId format', async () => {
      await expect(
        client.submitChatChunk('../evil', { index: 0, type: 'delta', content: '' }, 'agent-1'),
      ).rejects.toThrow('Invalid command ID format')
    })
  })

  describe('submitLogChunk', () => {
    it('should submit log chunk with correct parameters', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      await client.submitLogChunk({
        agentId: 'agent-1',
        projectCode: 'TEST_01',
        logType: 'docker-build',
        sessionId: '20240101T120000',
        seq: 0,
        text: 'Building image...',
      })

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/logs/chunk',
        {
          agentId: 'agent-1',
          projectCode: 'TEST_01',
          logType: 'docker-build',
          sessionId: '20240101T120000',
          seq: 0,
          text: 'Building image...',
        },
        undefined,
      )
    })

    it('should submit container log chunk', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      await client.submitLogChunk({
        agentId: 'agent-1',
        projectCode: 'TEST_01',
        logType: 'container',
        sessionId: '20240101T120000',
        seq: 5,
        text: 'Running...',
      })

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/logs/chunk',
        expect.objectContaining({ logType: 'container', seq: 5 }),
        undefined,
      )
    })
  })

  describe('saveSessionLog', () => {
    it('should save session log with extended timeout', async () => {
      mockInstance.post.mockResolvedValue({ data: {} })

      await client.saveSessionLog({
        agentId: 'agent-1',
        projectCode: 'TEST_01',
        logType: 'docker-build',
        sessionId: '20240101T120000',
        content: 'Full build log content here',
      })

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/logs/session',
        {
          agentId: 'agent-1',
          projectCode: 'TEST_01',
          logType: 'docker-build',
          sessionId: '20240101T120000',
          content: 'Full build log content here',
        },
        { timeout: 30_000 },
      )
    })
  })

  describe('getUploadUrl', () => {
    it('should request upload URL with correct parameters', async () => {
      mockInstance.post.mockResolvedValue({
        data: { uploadUrl: 'https://s3.example.com/upload', fileId: 'file-123', s3Key: 'uploads/file-123.txt' },
      })

      const result = await client.getUploadUrl({
        conversationId: 'conv-1',
        messageId: 'msg-1',
        filename: 'test.txt',
        contentType: 'text/plain',
        fileSize: 1024,
        projectCode: 'TEST_01',
      })

      expect(result.uploadUrl).toBe('https://s3.example.com/upload')
      expect(result.fileId).toBe('file-123')
      expect(result.s3Key).toBe('uploads/file-123.txt')
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/projects//agent/files/upload-url',
        {
          conversationId: 'conv-1',
          messageId: 'msg-1',
          filename: 'test.txt',
          contentType: 'text/plain',
          fileSize: 1024,
          projectCode: 'TEST_01',
        },
        undefined,
      )
    })
  })

  describe('getDownloadUrl', () => {
    it('should request download URL with correct parameters', async () => {
      mockInstance.post.mockResolvedValue({
        data: { downloadUrl: 'https://s3.example.com/download' },
      })

      const result = await client.getDownloadUrl({
        fileId: 'file-123',
        s3Key: 'uploads/file-123.txt',
      })

      expect(result.downloadUrl).toBe('https://s3.example.com/download')
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/projects//agent/files/download-url',
        {
          fileId: 'file-123',
          s3Key: 'uploads/file-123.txt',
        },
        undefined,
      )
    })
  })

  describe('retry logic', () => {
    beforeEach(() => {
      jest.useFakeTimers()
      mockedAxios.isAxiosError.mockImplementation(
        (err: unknown) => (err as Record<string, unknown>)?.isAxiosError === true,
      )
    })

    it('should retry on failure and succeed on second attempt', async () => {
      mockInstance.get
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockResolvedValueOnce({
          data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
        })

      const promise = client.getPendingCommands('agent-1')
      await jest.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toHaveLength(1)
      expect(mockInstance.get).toHaveBeenCalledTimes(2)
    })

    it('should throw after exhausting all retries', async () => {
      mockInstance.post
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockRejectedValueOnce(new Error('Network Error'))

      const promise = client
        .submitResult('cmd-1', { success: true, data: 'output' }, 'agent-1')
        .catch((e: unknown) => e)
      await jest.advanceTimersByTimeAsync(1000)
      await jest.advanceTimersByTimeAsync(2000)
      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe('Network Error')
      expect(mockInstance.post).toHaveBeenCalledTimes(3)
    })

    it('should not retry on 4xx client errors', async () => {
      mockInstance.post.mockRejectedValueOnce(createAxiosError('Bad Request', 400))

      await expect(
        client.submitResult('cmd-1', { success: true, data: 'output' }, 'agent-1'),
      ).rejects.toThrow('Bad Request')
      expect(mockInstance.post).toHaveBeenCalledTimes(1)
    })

    it('should retry on 429 rate limit', async () => {
      mockInstance.get
        .mockRejectedValueOnce(createAxiosError('Too Many Requests', 429))
        .mockResolvedValueOnce({
          data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
        })

      const promise = client.getPendingCommands('agent-1')
      await jest.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toHaveLength(1)
      expect(mockInstance.get).toHaveBeenCalledTimes(2)
    })

    it('should retry on 5xx server errors', async () => {
      mockInstance.get
        .mockRejectedValueOnce(createAxiosError('Internal Server Error', 500))
        .mockResolvedValueOnce({
          data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
        })

      const promise = client.getPendingCommands('agent-1')
      await jest.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toHaveLength(1)
      expect(mockInstance.get).toHaveBeenCalledTimes(2)
    })

    it('should apply jitter to retry delay (delay varies between runs)', async () => {
      // Verify jitter by collecting multiple delay values via Math.random mock
      const randomValues = [0.0, 0.5, 1.0]
      const expectedDelays = randomValues.map(r => Math.round(1000 * (0.5 + r * 0.5)))
      // r=0.0 → 500, r=0.5 → 750, r=1.0 → 1000

      for (let i = 0; i < randomValues.length; i++) {
        jest.spyOn(Math, 'random').mockReturnValue(randomValues[i])

        mockInstance.get
          .mockRejectedValueOnce(new Error('Network Error'))
          .mockResolvedValueOnce({
            data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
          })

        const promise = client.getPendingCommands('agent-1')
        await jest.advanceTimersByTimeAsync(expectedDelays[i])
        await promise

        jest.spyOn(Math, 'random').mockRestore()
        mockInstance.get.mockReset()
      }

      // The fact that all three resolved with different delays proves jitter works
      expect(expectedDelays).toEqual([500, 750, 1000])
    })

    it('should retry on network errors (no response)', async () => {
      const networkError = new Error('ECONNRESET')

      mockInstance.get
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({
          data: [{ commandId: 'cmd-1', type: 'execute_command', createdAt: 123 }],
        })

      const promise = client.getPendingCommands('agent-1')
      await jest.advanceTimersByTimeAsync(1000)
      const result = await promise
      expect(result).toHaveLength(1)
      expect(mockInstance.get).toHaveBeenCalledTimes(2)
    })
  })

  describe('updateToken', () => {
    it('should update Authorization header and extract tenantCode', () => {
      client.updateToken('new_tenant:tid:rawToken')
      expect(mockInstance.defaults.headers['Authorization']).toBe('Bearer new_tenant:tid:rawToken')
    })

    it('should not update tenantCode when token has fewer than 3 parts', () => {
      client.setTenantCode('original')
      client.updateToken('short-token')
      expect(mockInstance.defaults.headers['Authorization']).toBe('Bearer short-token')
    })
  })

  describe('updateE2eExecutionStatus', () => {
    it('should PUT to execution status endpoint', async () => {
      mockInstance.put.mockResolvedValue({})

      await client.updateE2eExecutionStatus('mbc', 'MBC_01', 'exec-1', { status: 'running' })

      expect(mockInstance.put).toHaveBeenCalledWith(
        expect.stringContaining('exec-1'),
        { status: 'running' },
        undefined,
      )
    })
  })

  describe('reportE2eTestStep', () => {
    it('should POST to execution steps endpoint', async () => {
      mockInstance.post.mockResolvedValue({})

      await client.reportE2eTestStep('mbc', 'MBC_01', 'exec-1', { stepNumber: 1, action: 'click' })

      expect(mockInstance.post).toHaveBeenCalledWith(
        expect.stringContaining('exec-1'),
        { stepNumber: 1, action: 'click' },
        undefined,
      )
    })
  })

  describe('updateE2eTestScript', () => {
    it('should PUT to execution script endpoint', async () => {
      mockInstance.put.mockResolvedValue({})

      await client.updateE2eTestScript('mbc', 'MBC_01', 'exec-1', { playwrightScript: 'code' })

      expect(mockInstance.put).toHaveBeenCalledWith(
        expect.stringContaining('exec-1'),
        { playwrightScript: 'code' },
        undefined,
      )
    })
  })

  describe('Alert API methods', () => {
    const mockAlertItem = {
      alertNumber: 'AL000001',
      alarmName: 'CPUHigh',
      state: 'ALARM',
      reason: 'Threshold Crossed',
      timestamp: '2026-05-13T00:00:00Z',
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      dimensions: [],
      status: 'pending',
      tenantCode: 'tenant1',
      projectCode: 'MBC_01',
    }

    describe('getPendingAlerts', () => {
      it('should GET pending alerts with status=pending only (no staleProcessingMinutes)', async () => {
        mockInstance.get.mockResolvedValue({ data: { items: [mockAlertItem], total: 1 } })

        const result = await client.getPendingAlerts('tenant1', 'MBC_01')

        expect(result.items).toHaveLength(1)
        expect(mockInstance.get).toHaveBeenCalledWith(
          '/api/tenant1/projects/MBC_01/alerts',
          expect.objectContaining({
            params: { status: 'pending', limit: 20 },
          }),
        )
      })
    })

    describe('getStaleProcessingAlerts', () => {
      it('should GET stale processing alerts with the given staleProcessingMinutes', async () => {
        mockInstance.get.mockResolvedValue({ data: { items: [mockAlertItem], total: 1 } })

        const result = await client.getStaleProcessingAlerts('tenant1', 'MBC_01', 30)

        expect(result.items).toHaveLength(1)
        expect(mockInstance.get).toHaveBeenCalledWith(
          '/api/tenant1/projects/MBC_01/alerts',
          expect.objectContaining({
            params: { status: 'pending', staleProcessingMinutes: 30, limit: 20 },
          }),
        )
      })
    })

    describe('getAlert', () => {
      it('should GET a single alert by alertNumber', async () => {
        mockInstance.get.mockResolvedValue({ data: mockAlertItem })

        const result = await client.getAlert('tenant1', 'MBC_01', 'AL000001')

        expect(result).toEqual(mockAlertItem)
        expect(mockInstance.get).toHaveBeenCalledWith(
          '/api/tenant1/projects/MBC_01/alerts/AL000001',
          undefined,
        )
      })

      it('should return null when alert not found', async () => {
        mockInstance.get.mockRejectedValue({ response: { status: 404 } })

        const result = await client.getAlert('tenant1', 'MBC_01', 'AL999999')

        expect(result).toBeNull()
      })

      it('should log a warning and return null when the request fails', async () => {
        mockedLogger.warn.mockClear()
        mockInstance.get.mockRejectedValue(new Error('boom'))

        const result = await client.getAlert('tenant1', 'MBC_01', 'AL000002')

        // Behaviour preserved: null is still returned
        expect(result).toBeNull()
        // Observability added: a warning identifies the failed alert
        expect(mockedLogger.warn).toHaveBeenCalledWith(
          'Failed to fetch alert',
          expect.objectContaining({
            tenantCode: 'tenant1',
            projectCode: 'MBC_01',
            alertNumber: 'AL000002',
            error: 'boom',
          }),
        )
      })
    })

    describe('updateAlertStatus', () => {
      it('should PUT alert status update', async () => {
        mockInstance.put.mockResolvedValue({})

        await client.updateAlertStatus('tenant1', 'MBC_01', 'AL000001', {
          status: 'processed',
          issueId: 'AI_SU000001',
        })

        expect(mockInstance.put).toHaveBeenCalledWith(
          '/api/tenant1/projects/MBC_01/alerts/AL000001/status',
          { status: 'processed', issueId: 'AI_SU000001' },
          undefined,
        )
      })
    })

    describe('findActiveIssueByAlarmName', () => {
      it('should return issue id when active issue found', async () => {
        mockInstance.get.mockResolvedValue({ data: { id: 'AI_SU000001' } })

        const result = await client.findActiveIssueByAlarmName('tenant1', 'MBC_01', 'CPUHigh')

        expect(result).toEqual({ id: 'AI_SU000001' })
        expect(mockInstance.get).toHaveBeenCalledWith(
          '/api/tenant1/projects/MBC_01/alerts/active-issue',
          expect.objectContaining({
            params: expect.objectContaining({ alarmName: 'CPUHigh' }),
          }),
        )
      })

      it('should return null when no active issue found', async () => {
        mockInstance.get.mockResolvedValue({ data: null })

        const result = await client.findActiveIssueByAlarmName('tenant1', 'MBC_01', 'CPUHigh')

        expect(result).toBeNull()
      })
    })

    describe('resolveIssueFromAlert', () => {
      it('should POST to resolve-issue endpoint', async () => {
        mockInstance.post.mockResolvedValue({})

        await client.resolveIssueFromAlert('tenant1', 'MBC_01', 'AL000001', 'JCCI_000071')

        expect(mockInstance.post).toHaveBeenCalledWith(
          '/api/tenant1/projects/MBC_01/alerts/AL000001/resolve-issue',
          { issueId: 'JCCI_000071' },
          undefined,
        )
      })
    })
  })

  describe('sendSlackMessage', () => {
    it('should POST to send-slack-message endpoint and return the result', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: true, data: { messageTs: '1234567890.123456', permalink: 'https://slack.example.com/p1' } },
      })

      const result = await client.sendSlackMessage('#general', 'hello world')

      expect(result).toEqual({
        success: true,
        data: { messageTs: '1234567890.123456', permalink: 'https://slack.example.com/p1' },
      })
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/send-slack-message',
        { channel: '#general', message: 'hello world', threadTs: undefined },
        undefined,
      )
    })

    it('should pass threadTs when provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true, data: { messageTs: 'ts-1' } } })

      await client.sendSlackMessage('#general', 'reply', '111.222')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/send-slack-message',
        { channel: '#general', message: 'reply', threadTs: '111.222' },
        undefined,
      )
    })

    it('should include callId in the POST body when provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true, data: { messageTs: 'ts-1' } } })

      await client.sendSlackMessage('#general', 'hello world', undefined, 'call-id-1')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/send-slack-message',
        { channel: '#general', message: 'hello world', threadTs: undefined, callId: 'call-id-1' },
        undefined,
      )
    })

    it('should return failure result when API reports an error', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: false, error: { code: 'SLACK_ERROR', message: 'channel_not_found' } },
      })

      const result = await client.sendSlackMessage('#missing', 'hello')

      expect(result).toEqual({
        success: false,
        error: { code: 'SLACK_ERROR', message: 'channel_not_found' },
      })
    })
  })

  describe('sendSlackFile', () => {
    it('should POST to send-slack-file endpoint and return the result', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: true, data: { fileId: 'F123456', permalink: 'https://slack.example.com/files/F123456' } },
      })

      const result = await client.sendSlackFile('#general', 'cost.csv', 'a,b\n1,2')

      expect(result).toEqual({
        success: true,
        data: { fileId: 'F123456', permalink: 'https://slack.example.com/files/F123456' },
      })
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/send-slack-file',
        { channel: '#general', fileName: 'cost.csv', content: 'a,b\n1,2', threadTs: undefined },
        { timeout: 60_000 },
      )
    })

    it('should pass threadTs when provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true, data: { fileId: 'F1' } } })

      await client.sendSlackFile('#general', 'cost.csv', 'data', '111.222')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/send-slack-file',
        { channel: '#general', fileName: 'cost.csv', content: 'data', threadTs: '111.222' },
        { timeout: 60_000 },
      )
    })

    it('should include callId in the POST body when provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true, data: { fileId: 'F1' } } })

      await client.sendSlackFile('#general', 'cost.csv', 'data', undefined, 'call-id-1')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/send-slack-file',
        { channel: '#general', fileName: 'cost.csv', content: 'data', threadTs: undefined, callId: 'call-id-1' },
        { timeout: 60_000 },
      )
    })

    it('should return failure result when API reports an error', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: false, error: { code: 'NOT_FOUND', message: "チャンネル 'x' が見つかりません" } },
      })

      const result = await client.sendSlackFile('#missing', 'cost.csv', 'data')

      expect(result).toEqual({
        success: false,
        error: { code: 'NOT_FOUND', message: "チャンネル 'x' が見つかりません" },
      })
    })
  })

  describe('triggerAlarm', () => {
    it('should POST to trigger-alarm endpoint and return the result', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: true, data: { alertNumber: 'AL000123', status: 'created' } },
      })

      const result = await client.triggerAlarm('DB down', 'Connection refused on primary DB', 'urgent')

      expect(result).toEqual({
        success: true,
        data: { alertNumber: 'AL000123', status: 'created' },
      })
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/trigger-alarm',
        { title: 'DB down', reason: 'Connection refused on primary DB', priority: 'urgent' },
        undefined,
      )
    })

    it('should work without an explicit priority', async () => {
      mockInstance.post.mockResolvedValue({ data: { success: true, data: { status: 'created' } } })

      await client.triggerAlarm('DB down', 'Connection refused')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/trigger-alarm',
        { title: 'DB down', reason: 'Connection refused', priority: undefined },
        undefined,
      )
    })

    it('should return failure result when API reports an error', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: false, error: { code: 'ALARM_ERROR', message: 'rate limited' } },
      })

      const result = await client.triggerAlarm('DB down', 'Connection refused')

      expect(result).toEqual({
        success: false,
        error: { code: 'ALARM_ERROR', message: 'rate limited' },
      })
    })

    it('should include callId in the POST body when provided', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: true, data: { alertNumber: 'AL000123', status: 'created' } },
      })

      await client.triggerAlarm('DB down', 'Connection refused', 'urgent', 'call-id-1')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/trigger-alarm',
        { title: 'DB down', reason: 'Connection refused', priority: 'urgent', callId: 'call-id-1' },
        undefined,
      )
    })
  })

  describe('triggerE2eTest', () => {
    it('should POST to trigger-e2e-test endpoint and return the result', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: true, data: { executionId: 'exec-1', dispatched: true } },
      })

      const result = await client.triggerE2eTest('case-456', 'task-abc-123')

      expect(result).toEqual({
        success: true,
        data: { executionId: 'exec-1', dispatched: true },
      })
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/trigger-e2e-test',
        {
          testCaseId: 'case-456',
          taskId: 'task-abc-123',
          executionMethod: undefined,
          environmentId: undefined,
          callId: undefined,
        },
        undefined,
      )
    })

    it('should include executionMethod, environmentId, and callId when provided', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: true, data: { executionId: 'exec-1', dispatched: true } },
      })

      await client.triggerE2eTest('case-456', 'task-abc-123', 'playwright', 'env-1', 'call-id-1')

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/trigger-e2e-test',
        {
          testCaseId: 'case-456',
          taskId: 'task-abc-123',
          executionMethod: 'playwright',
          environmentId: 'env-1',
          callId: 'call-id-1',
        },
        undefined,
      )
    })

    it('should return failure result when API reports an error', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: false, error: { code: 'INVALID_INPUT', message: 'testCaseId は必須です' } },
      })

      const result = await client.triggerE2eTest('case-456', 'task-abc-123')

      expect(result).toEqual({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'testCaseId は必須です' },
      })
    })
  })

  describe('readSlackThread', () => {
    it('should POST to read-slack-thread endpoint with the chatConversationId and return the result', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: true, data: { text: '[2026/01/01 12:00] U012: hello' } },
      })

      const result = await client.readSlackThread('conv-123')

      expect(result).toEqual({
        success: true,
        data: { text: '[2026/01/01 12:00] U012: hello' },
      })
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/tools/read-slack-thread',
        { chatConversationId: 'conv-123' },
        undefined,
      )
    })

    it('should return failure result when API reports an error', async () => {
      mockInstance.post.mockResolvedValue({
        data: { success: false, error: { code: 'NOT_FOUND', message: 'このスレッドはSlack会話に紐づいていません' } },
      })

      const result = await client.readSlackThread('conv-not-slack')

      expect(result).toEqual({
        success: false,
        error: { code: 'NOT_FOUND', message: 'このスレッドはSlack会話に紐づいていません' },
      })
    })
  })

  describe('updateSystemKnowledge', () => {
    it('should POST to the agent/knowledge endpoint and return the created knowledge entry', async () => {
      const knowledge = {
        id: 'kn-1', tenantCode: 'test_tenant', category: 'faq', title: 'Title', content: 'Content', status: 'draft',
      }
      mockInstance.post.mockResolvedValue({ data: knowledge })

      const result = await client.updateSystemKnowledge({
        title: 'Title',
        content: 'Content',
        category: 'faq',
        commandId: 'cmd-1',
        agentId: 'agent-1',
        callId: 'call-1',
      })

      expect(result).toEqual(knowledge)
      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/knowledge',
        {
          title: 'Title',
          content: 'Content',
          category: 'faq',
          commandId: 'cmd-1',
          agentId: 'agent-1',
          callId: 'call-1',
        },
        undefined,
      )
    })

    it('should include id (revision), tags, and sourceIssue when provided', async () => {
      mockInstance.post.mockResolvedValue({ data: { id: 'kn-1', status: 'published' } })

      await client.updateSystemKnowledge({
        id: 'kn-1',
        title: 'Title',
        content: 'Content',
        category: 'faq',
        tags: ['a', 'b'],
        sourceIssue: 'ISSUE-1',
        commandId: 'cmd-1',
        agentId: 'agent-1',
        callId: 'call-1',
      })

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/knowledge',
        {
          id: 'kn-1',
          title: 'Title',
          content: 'Content',
          category: 'faq',
          tags: ['a', 'b'],
          sourceIssue: 'ISSUE-1',
          commandId: 'cmd-1',
          agentId: 'agent-1',
          callId: 'call-1',
        },
        undefined,
      )
    })

    it('should work without commandId/agentId/callId (e.g. tool invoked outside a chat command context)', async () => {
      mockInstance.post.mockResolvedValue({ data: { id: 'kn-1', status: 'draft' } })

      await client.updateSystemKnowledge({
        title: 'Title',
        content: 'Content',
        category: 'faq',
      })

      expect(mockInstance.post).toHaveBeenCalledWith(
        '/api/test_tenant/agent/knowledge',
        {
          title: 'Title',
          content: 'Content',
          category: 'faq',
        },
        undefined,
      )
    })

    it('should propagate errors (e.g. validation 4xx) without swallowing them', async () => {
      mockInstance.post.mockRejectedValue(createAxiosError('title is required', 400))

      await expect(client.updateSystemKnowledge({
        title: '',
        content: 'Content',
        category: 'faq',
      })).rejects.toThrow()
    })
  })

  describe('idempotency: callId stays identical across HTTP retries', () => {
    beforeEach(() => {
      jest.useFakeTimers()
      mockedAxios.isAxiosError.mockImplementation(
        (err: unknown) => (err as Record<string, unknown>)?.isAxiosError === true,
      )
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('sends the same callId on every retry attempt for triggerAlarm', async () => {
      mockInstance.post
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockResolvedValueOnce({ data: { success: true, data: { status: 'created' } } })

      const promise = client.triggerAlarm('DB down', 'Connection refused', 'urgent', 'fixed-call-id')
      await jest.advanceTimersByTimeAsync(1000)
      await promise

      expect(mockInstance.post).toHaveBeenCalledTimes(2)
      const firstBody = mockInstance.post.mock.calls[0][1]
      const secondBody = mockInstance.post.mock.calls[1][1]
      expect(firstBody).toEqual(secondBody)
      expect(firstBody.callId).toBe('fixed-call-id')
    })

    it('sends the same callId on every retry attempt for sendSlackMessage', async () => {
      mockInstance.post
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockResolvedValueOnce({ data: { success: true, data: { messageTs: 'ts-1' } } })

      const promise = client.sendSlackMessage('#general', 'hello world', undefined, 'fixed-call-id-2')
      await jest.advanceTimersByTimeAsync(1000)
      await promise

      expect(mockInstance.post).toHaveBeenCalledTimes(2)
      const firstBody = mockInstance.post.mock.calls[0][1]
      const secondBody = mockInstance.post.mock.calls[1][1]
      expect(firstBody).toEqual(secondBody)
      expect(firstBody.callId).toBe('fixed-call-id-2')
    })
  })
})
