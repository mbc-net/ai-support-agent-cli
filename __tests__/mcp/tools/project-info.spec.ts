import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerProjectInfoTool } from '../../../src/mcp/tools/project-info'

jest.mock('../../../src/api-client')
jest.mock('../../../src/logger')

describe('project-info tool', () => {
  let toolCallback: (args: Record<string, never>) => Promise<unknown>

  function setupTool(mockClient: Partial<ApiClient>, projectCode = 'TEST_01') {
    const mockServer = {
      tool: jest.fn().mockImplementation((_n: string, _d: string, _s: unknown, cb: typeof toolCallback) => {
        toolCallback = cb
      }),
    } as unknown as McpServer

    registerProjectInfoTool(mockServer, mockClient as ApiClient, projectCode)
  }

  describe('registerProjectInfoTool', () => {
    it('should register the tool on the server', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerProjectInfoTool(mockServer, mockClient, 'TEST_01')

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'get_project_info',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })
  })

  describe('callback', () => {
    it('should return project info with databases', async () => {
      setupTool({
        getProjectConfig: jest.fn().mockResolvedValue({
          configHash: 'abc',
          project: { projectCode: 'TEST_01', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
          databases: [
            { name: 'MAIN', engine: 'mysql', host: 'db.local', port: 3306, database: 'mydb' },
          ],
        }),
      })

      const result = await toolCallback({} as Record<string, never>) as { content: Array<{ text: string }> }
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.project.projectCode).toBe('TEST_01')
      expect(parsed.databases).toHaveLength(1)
      expect(parsed.databases[0].name).toBe('MAIN')
      expect(parsed.projectCode).toBe('TEST_01')
    })

    it('should return project info with AWS accounts', async () => {
      setupTool({
        getProjectConfig: jest.fn().mockResolvedValue({
          configHash: 'abc',
          project: { projectCode: 'TEST_01', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
          aws: {
            accounts: [
              { id: 'acc-1', name: 'Main', region: 'ap-northeast-1', accountId: '123456789', isDefault: true, auth: { method: 'access_key' } },
            ],
          },
        }),
      })

      const result = await toolCallback({} as Record<string, never>) as { content: Array<{ text: string }> }
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.awsAccounts).toHaveLength(1)
      expect(parsed.awsAccounts[0].id).toBe('acc-1')
    })

    it('should return project info with documentation', async () => {
      setupTool({
        getProjectConfig: jest.fn().mockResolvedValue({
          configHash: 'abc',
          project: { projectCode: 'TEST_01', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
          documentation: { sources: [{ type: 'url', url: 'https://docs.example.com' }] },
        }),
      })

      const result = await toolCallback({} as Record<string, never>) as { content: Array<{ text: string }> }
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.documentation.sources).toHaveLength(1)
    })

    it('should return project info with SSH hosts', async () => {
      setupTool({
        getProjectConfig: jest.fn().mockResolvedValue({
          configHash: 'abc',
          project: { projectCode: 'TEST_01', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
          ssh: {
            enabled: true,
            hosts: [
              { hostId: 'PROD_SERVER', name: 'Production', hostname: '192.168.1.100', port: 22, username: 'deploy', authType: 'privateKey', description: 'Main server' },
              { hostId: 'STAGING', name: 'Staging', hostname: '192.168.1.200', username: 'admin', authType: 'password', environment: 'staging' },
            ],
          },
        }),
      })

      const result = await toolCallback({} as Record<string, never>) as { content: Array<{ text: string }> }
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.ssh.enabled).toBe(true)
      expect(parsed.ssh.hosts).toHaveLength(2)
      expect(parsed.ssh.hosts[0].hostId).toBe('PROD_SERVER')
      expect(parsed.ssh.hosts[0].port).toBe(22)
      expect(parsed.ssh.hosts[1].port).toBe(22) // default port
      expect(parsed.ssh.hosts[1].environment).toBe('staging')
    })

    it('should not include SSH when disabled', async () => {
      setupTool({
        getProjectConfig: jest.fn().mockResolvedValue({
          configHash: 'abc',
          project: { projectCode: 'TEST_01', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
          ssh: { enabled: false, hosts: [] },
        }),
      })

      const result = await toolCallback({} as Record<string, never>) as { content: Array<{ text: string }> }
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.ssh).toBeUndefined()
    })

    it('should return minimal project info when no optional data', async () => {
      setupTool({
        getProjectConfig: jest.fn().mockResolvedValue({
          configHash: 'abc',
          project: { projectCode: 'TEST_01', projectName: 'Test' },
          agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true, externalAgentEnabled: true, allowedTools: [] },
        }),
      })

      const result = await toolCallback({} as Record<string, never>) as { content: Array<{ text: string }> }
      const parsed = JSON.parse(result.content[0].text)
      expect(parsed.project.projectCode).toBe('TEST_01')
      expect(parsed.databases).toBeUndefined()
      expect(parsed.awsAccounts).toBeUndefined()
      expect(parsed.documentation).toBeUndefined()
    })

    it('should handle errors', async () => {
      setupTool({
        getProjectConfig: jest.fn().mockRejectedValue(new Error('Network error')),
      })

      const result = await toolCallback({} as Record<string, never>)
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Network error' }],
        isError: true,
      })
    })

    it('should handle non-Error throws', async () => {
      setupTool({
        getProjectConfig: jest.fn().mockRejectedValue('unexpected'),
      })

      const result = await toolCallback({} as Record<string, never>)
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: unexpected' }],
        isError: true,
      })
    })
  })
})
