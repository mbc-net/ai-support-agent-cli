import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { ApiClient } from '../../../src/api-client'
import { registerUpdateSystemKnowledgeTool } from '../../../src/mcp/tools/update-system-knowledge'

jest.mock('../../../src/api-client')

// randomUUID() produces v4 UUIDs
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ToolArgs {
  id?: string
  title: string
  content: string
  category: string
  tags?: string[]
  sourceIssue?: string
}

describe('update-system-knowledge tool', () => {
  let toolCallback: (args: ToolArgs) => Promise<unknown>
  let toolSchema: Record<string, unknown>
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function buildMockServer(): McpServer {
    return {
      tool: jest.fn().mockImplementation((_n: string, _d: string, schema: Record<string, unknown>, cb: typeof toolCallback) => {
        toolSchema = schema
        toolCallback = cb
      }),
    } as unknown as McpServer
  }

  describe('registerUpdateSystemKnowledgeTool', () => {
    it('should register the tool on the server with the expected name', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerUpdateSystemKnowledgeTool(mockServer, mockClient)

      expect((mockServer.tool as jest.Mock)).toHaveBeenCalledWith(
        'update_system_knowledge',
        expect.any(String),
        expect.any(Object),
        expect.any(Function),
      )
    })

    it('should describe when to use the tool over local file writes', () => {
      const mockServer = { tool: jest.fn() } as unknown as McpServer
      const mockClient = {} as ApiClient

      registerUpdateSystemKnowledgeTool(mockServer, mockClient)

      const description = (mockServer.tool as jest.Mock).mock.calls[0][1] as string
      expect(description.toLowerCase()).toContain('knowledge base')
      expect(description.toLowerCase()).toContain('local file')
    })

    it('should NOT expose commandId, agentId, callId, canPublishHint, requesterUserId, projectCode, or tenantCode in the tool schema', () => {
      const mockServer = buildMockServer()
      const mockClient = {} as ApiClient

      registerUpdateSystemKnowledgeTool(mockServer, mockClient)

      expect(Object.keys(toolSchema)).not.toContain('commandId')
      expect(Object.keys(toolSchema)).not.toContain('agentId')
      expect(Object.keys(toolSchema)).not.toContain('callId')
      expect(Object.keys(toolSchema)).not.toContain('canPublishHint')
      expect(Object.keys(toolSchema)).not.toContain('requesterUserId')
      expect(Object.keys(toolSchema)).not.toContain('projectCode')
      expect(Object.keys(toolSchema)).not.toContain('tenantCode')
      // Sanity: the schema does expose the fields the LLM is allowed to set
      expect(Object.keys(toolSchema)).toEqual(
        expect.arrayContaining(['title', 'content', 'category', 'tags', 'sourceIssue', 'id']),
      )
    })

    it('should read commandId/agentId from env vars (not from tool args) and forward them to the API', async () => {
      process.env.AI_SUPPORT_AGENT_KNOWLEDGE_COMMAND_ID = 'cmd-123'
      process.env.AI_SUPPORT_AGENT_KNOWLEDGE_AGENT_ID = 'agent-456'
      const mockServer = buildMockServer()
      const mockClient = {
        updateSystemKnowledge: jest.fn().mockResolvedValue({
          id: 'kn-1', tenantCode: 'mbc', category: 'faq', title: 'Title', content: 'Content', status: 'draft',
        }),
      } as unknown as ApiClient

      registerUpdateSystemKnowledgeTool(mockServer, mockClient)

      // Attacker/LLM attempts to pass commandId/agentId directly as args — the schema
      // doesn't declare them so the MCP SDK would strip them, but even if a permissive
      // caller invoked the raw callback with these keys present, the implementation must
      // ignore them and use the env-derived values only.
      await toolCallback({
        title: 'Title',
        content: 'Content',
        category: 'faq',
        // @ts-expect-error verifying the implementation ignores unexpected args
        commandId: 'attacker-supplied-command-id',
        // @ts-expect-error verifying the implementation ignores unexpected args
        agentId: 'attacker-supplied-agent-id',
      })

      expect((mockClient.updateSystemKnowledge as jest.Mock)).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Title',
          content: 'Content',
          category: 'faq',
          commandId: 'cmd-123',
          agentId: 'agent-456',
          callId: expect.stringMatching(UUID_V4_REGEX),
        }),
      )
    })

    it('should leave commandId/agentId undefined when the env vars are not set', async () => {
      delete process.env.AI_SUPPORT_AGENT_KNOWLEDGE_COMMAND_ID
      delete process.env.AI_SUPPORT_AGENT_KNOWLEDGE_AGENT_ID
      const mockServer = buildMockServer()
      const mockClient = {
        updateSystemKnowledge: jest.fn().mockResolvedValue({ id: 'kn-1', status: 'draft' }),
      } as unknown as ApiClient

      registerUpdateSystemKnowledgeTool(mockServer, mockClient)

      await toolCallback({ title: 'Title', content: 'Content', category: 'faq' })

      const call = (mockClient.updateSystemKnowledge as jest.Mock).mock.calls[0][0]
      expect(call.commandId).toBeUndefined()
      expect(call.agentId).toBeUndefined()
    })

    it('should generate a fresh callId (UUID v4) per invocation', async () => {
      const mockServer = buildMockServer()
      const mockClient = {
        updateSystemKnowledge: jest.fn().mockResolvedValue({ id: 'kn-1', status: 'draft' }),
      } as unknown as ApiClient

      registerUpdateSystemKnowledgeTool(mockServer, mockClient)

      await toolCallback({ title: 'Title', content: 'Content', category: 'faq' })
      await toolCallback({ title: 'Title 2', content: 'Content 2', category: 'faq' })

      const calls = (mockClient.updateSystemKnowledge as jest.Mock).mock.calls
      expect(calls[0][0].callId).toEqual(expect.stringMatching(UUID_V4_REGEX))
      expect(calls[1][0].callId).toEqual(expect.stringMatching(UUID_V4_REGEX))
      expect(calls[0][0].callId).not.toBe(calls[1][0].callId)
    })

    it('should forward id, tags, and sourceIssue when provided (revision path)', async () => {
      process.env.AI_SUPPORT_AGENT_KNOWLEDGE_COMMAND_ID = 'cmd-rev-1'
      process.env.AI_SUPPORT_AGENT_KNOWLEDGE_AGENT_ID = 'agent-rev-1'
      const mockServer = buildMockServer()
      const mockClient = {
        updateSystemKnowledge: jest.fn().mockResolvedValue({ id: 'kn-1', status: 'published' }),
      } as unknown as ApiClient

      registerUpdateSystemKnowledgeTool(mockServer, mockClient)

      await toolCallback({
        id: 'kn-1',
        title: 'Title',
        content: 'Content',
        category: 'faq',
        tags: ['tag1', 'tag2'],
        sourceIssue: 'ISSUE-1',
      })

      expect((mockClient.updateSystemKnowledge as jest.Mock)).toHaveBeenCalledWith({
        id: 'kn-1',
        title: 'Title',
        content: 'Content',
        category: 'faq',
        tags: ['tag1', 'tag2'],
        sourceIssue: 'ISSUE-1',
        commandId: 'cmd-rev-1',
        agentId: 'agent-rev-1',
        callId: expect.stringMatching(UUID_V4_REGEX),
      })
    })

    it('should return a JSON response on success', async () => {
      const mockServer = buildMockServer()
      const knowledge = { id: 'kn-1', tenantCode: 'mbc', category: 'faq', title: 'Title', content: 'Content', status: 'published' }
      const mockClient = {
        updateSystemKnowledge: jest.fn().mockResolvedValue(knowledge),
      } as unknown as ApiClient

      registerUpdateSystemKnowledgeTool(mockServer, mockClient)

      const result = await toolCallback({ title: 'Title', content: 'Content', category: 'faq' })

      expect(result).toEqual({
        content: [{ type: 'text', text: JSON.stringify(knowledge, null, 2) }],
      })
    })

    it('should return an mcpErrorResponse without any local file fallback when the API call fails', async () => {
      const mockServer = buildMockServer()
      const mockClient = {
        updateSystemKnowledge: jest.fn().mockRejectedValue(new Error('Request failed with status code 400')),
      } as unknown as ApiClient
      const fs = require('fs')
      const writeFileSpy = jest.spyOn(fs, 'writeFileSync')

      registerUpdateSystemKnowledgeTool(mockServer, mockClient)

      const result = await toolCallback({ title: 'Title', content: 'Content', category: 'faq' })

      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: Request failed with status code 400' }],
        isError: true,
      })
      expect(writeFileSpy).not.toHaveBeenCalled()
      writeFileSpy.mockRestore()
    })
  })
})
