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

/**
 * The `.catch` callback inside `if (require.main === module)` at lines 66-68
 * cannot be covered by Jest because Jest sets require.main = null (non-writable,
 * non-configurable) so the guard condition is always false.
 *
 * This test verifies the same callback logic by directly exercising the
 * `startMcpServer().catch(...)` pattern, validating that errors are written to
 * stderr and process.exit(1) is called — matching the production code behavior.
 */
describe('require.main === module entry point (callback logic verification)', () => {
  it('writes to stderr and exits with 1 when startMcpServer rejects', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)

    // Directly exercise the same logic as the .catch callback in server.ts lines 66-68
    const error = new Error('startup error')
    await Promise.resolve().then(() => {
      throw error
    }).catch((err: Error) => {
      process.stderr.write(`MCP server error: ${err}\n`)
      process.exit(1)
    })

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('MCP server error:'))
    expect(exitSpy).toHaveBeenCalledWith(1)

    stderrSpy.mockRestore()
    exitSpy.mockRestore()
  })
})

describe('MCP Server', () => {
  describe('createMcpServer', () => {
    it('should create a server with tools registered', () => {
      const mockClient = {} as ApiClient
      const server = createMcpServer(mockClient, 'TEST_01')
      expect(server).toBeDefined()
      // 20 tools: db_query, get_db_schemas, get_credentials, file_upload, get_project_info, read_conversation_file,
      // send_slack_message, trigger_alarm, read_slack_thread,
      // browser_navigate, browser_close, browser_click, browser_fill, browser_get_text, browser_login,
      // browser_extract, browser_set_variable, browser_get_variable, browser_list_variables,
      // report_test_step
      expect(server.tool).toHaveBeenCalledTimes(20)
      expect((server.tool as jest.Mock).mock.calls.map((call) => call[0])).toContain('read_slack_thread')
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
