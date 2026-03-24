import { ApiClient } from '../../src/api-client'
import { createMcpServer, startMcpServer } from '../../src/mcp/server'

jest.mock('../../src/api-client')
jest.mock('../../src/logger')
jest.mock('../../src/mcp/tools/browser/playwright-loader', () => ({
  loadPlaywright: jest.fn(),
  isPlaywrightAvailable: jest.fn().mockReturnValue(true),
}))
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    tool: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
  })),
}))
jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({})),
}))

describe('MCP Server', () => {
  describe('createMcpServer', () => {
    it('should create a server with tools registered', () => {
      const mockClient = {} as ApiClient
      const server = createMcpServer(mockClient, 'TEST_01')
      expect(server).toBeDefined()
      // 16 tools: db_query, get_db_schemas, get_credentials, file_upload, get_project_info, read_conversation_file,
      // browser_navigate, browser_close, browser_click, browser_fill, browser_get_text, browser_login,
      // browser_extract, browser_set_variable, browser_get_variable, browser_list_variables
      expect(server.tool).toHaveBeenCalledTimes(16)
    })
  })

  describe('startMcpServer', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('should throw if API URL is missing', async () => {
      delete process.env.AI_SUPPORT_AGENT_API_URL
      process.env.AI_SUPPORT_AGENT_TOKEN = 'token'
      process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'TEST'

      await expect(startMcpServer()).rejects.toThrow('Missing required environment variables: AI_SUPPORT_AGENT_API_URL')
    })

    it('should throw if TOKEN is missing', async () => {
      process.env.AI_SUPPORT_AGENT_API_URL = 'http://localhost:3030'
      delete process.env.AI_SUPPORT_AGENT_TOKEN
      process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'TEST'

      await expect(startMcpServer()).rejects.toThrow('Missing required environment variables: AI_SUPPORT_AGENT_TOKEN')
    })

    it('should throw if PROJECT_CODE is missing', async () => {
      process.env.AI_SUPPORT_AGENT_API_URL = 'http://localhost:3030'
      process.env.AI_SUPPORT_AGENT_TOKEN = 'token'
      delete process.env.AI_SUPPORT_AGENT_PROJECT_CODE

      await expect(startMcpServer()).rejects.toThrow('Missing required environment variables: AI_SUPPORT_AGENT_PROJECT_CODE')
    })

    it('should throw if all vars are missing', async () => {
      delete process.env.AI_SUPPORT_AGENT_API_URL
      delete process.env.AI_SUPPORT_AGENT_TOKEN
      delete process.env.AI_SUPPORT_AGENT_PROJECT_CODE

      await expect(startMcpServer()).rejects.toThrow('Missing required environment variables: AI_SUPPORT_AGENT_API_URL, AI_SUPPORT_AGENT_TOKEN, AI_SUPPORT_AGENT_PROJECT_CODE')
    })

    it('should start successfully with all vars set', async () => {
      process.env.AI_SUPPORT_AGENT_API_URL = 'http://localhost:3030'
      process.env.AI_SUPPORT_AGENT_TOKEN = 'test-token'
      process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'TEST_01'

      await expect(startMcpServer()).resolves.toBeUndefined()
    })

    it('should set tenantCode on ApiClient when AI_SUPPORT_AGENT_TENANT_CODE is provided', async () => {
      process.env.AI_SUPPORT_AGENT_API_URL = 'http://localhost:3030'
      process.env.AI_SUPPORT_AGENT_TOKEN = 'test-token'
      process.env.AI_SUPPORT_AGENT_PROJECT_CODE = 'TEST_01'
      process.env.AI_SUPPORT_AGENT_TENANT_CODE = 'test_tenant'

      await startMcpServer()

      const MockedApiClient = ApiClient as jest.MockedClass<typeof ApiClient>
      const instance = MockedApiClient.mock.instances[MockedApiClient.mock.instances.length - 1]
      expect(instance.setTenantCode).toHaveBeenCalledWith('test_tenant')
    })
  })
})
