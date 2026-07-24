/**
 * Tests for src/commands/claude-code-args.ts
 *
 * Covers the uncovered branch where process.env contains an entry with
 * value === undefined, which should be excluded from the clean env object.
 */

import { buildCleanEnv, _resetCleanEnvCache, buildClaudeArgs } from '../../src/commands/claude-code-args'
import { ENV_VARS, DEFAULT_CLAUDE_MODEL } from '../../src/constants'

describe('claude-code-args', () => {
  describe('buildCleanEnv - undefined value branch', () => {
    const originalEnv = process.env

    beforeEach(() => {
      _resetCleanEnvCache()
    })

    afterEach(() => {
      process.env = originalEnv
      _resetCleanEnvCache()
    })

    it('should exclude env entries where value is undefined', () => {
      // Simulate a process.env with an undefined value (can occur via Object.assign tricks)
      process.env = Object.assign(Object.create(null), {
        HOME: '/home/user',
        UNDEFINED_VAR: undefined as unknown as string,
        PATH: '/usr/bin',
      })

      const result = buildCleanEnv()

      expect(result).toHaveProperty('HOME', '/home/user')
      expect(result).toHaveProperty('PATH', '/usr/bin')
      expect(result).not.toHaveProperty('UNDEFINED_VAR')
    })

    it('should exclude CLAUDECODE and keep other defined vars', () => {
      process.env = {
        CLAUDECODE: '1',
        HOME: '/home/user',
        MY_VAR: 'hello',
      }

      const result = buildCleanEnv()

      expect(result).not.toHaveProperty('CLAUDECODE')
      expect(result).toHaveProperty('HOME', '/home/user')
      expect(result).toHaveProperty('MY_VAR', 'hello')
    })

    it('should exclude CLAUDE_CODE_* vars but keep CLAUDE_CODE_OAUTH_TOKEN', () => {
      process.env = {
        CLAUDE_CODE_SSE_PORT: '1234',
        [ENV_VARS.CLAUDE_CODE_OAUTH_TOKEN]: 'my-token',
        HOME: '/home/user',
      }

      const result = buildCleanEnv()

      expect(result).not.toHaveProperty('CLAUDE_CODE_SSE_PORT')
      expect(result).toHaveProperty(ENV_VARS.CLAUDE_CODE_OAUTH_TOKEN, 'my-token')
      expect(result).toHaveProperty('HOME', '/home/user')
    })

    it('should return a copy that does not share references with the cache', () => {
      process.env = { HOME: '/home/user' }

      const result1 = buildCleanEnv()
      const result2 = buildCleanEnv()

      // Different object references
      expect(result1).not.toBe(result2)
      // But same content
      expect(result1).toEqual(result2)
    })

    it('should cache the result for subsequent calls without re-iterating process.env', () => {
      process.env = { HOME: '/home/user', PATH: '/usr/bin' }

      const result1 = buildCleanEnv()

      // Change env after first call — the cache should return the original values
      process.env.NEW_VAR = 'added-after-cache'

      const result2 = buildCleanEnv()

      expect(result1).toEqual(result2)
      expect(result2).not.toHaveProperty('NEW_VAR')
    })
  })

  describe('buildClaudeArgs - comprehensive', () => {
    it('should return base args with message at end (no --model when model is undefined)', () => {
      const result = buildClaudeArgs('my message')
      expect(result).toEqual(['-p', '--output-format', 'stream-json', '--verbose', 'my message'])
    })

    it('should NOT add --model when model is not provided (caller resolves the value)', () => {
      const result = buildClaudeArgs('msg')
      expect(result).not.toContain('--model')
    })

    it('should use the provided model for --model when specified', () => {
      const result = buildClaudeArgs('msg', { model: 'claude-opus-4-8' })
      expect(result).toContain('--model')
      const modelIdx = result.indexOf('--model')
      expect(result[modelIdx + 1]).toBe('claude-opus-4-8')
    })

    it('should add --model with DEFAULT_CLAUDE_MODEL when caller passes it explicitly', () => {
      const result = buildClaudeArgs('msg', { model: DEFAULT_CLAUDE_MODEL })
      const modelIdx = result.indexOf('--model')
      expect(result[modelIdx + 1]).toBe('claude-sonnet-4-6')
    })

    it('should add --allowedTools flag for each tool in the list', () => {
      const result = buildClaudeArgs('msg', { allowedTools: ['Bash', 'Read', 'Write'] })
      expect(result).toContain('--allowedTools')
      expect(result).toContain('Bash')
      expect(result).toContain('Read')
      expect(result).toContain('Write')
      // Each tool gets its own --allowedTools flag
      expect(result.filter((a) => a === '--allowedTools')).toHaveLength(3)
    })

    it('should not include --allowedTools when allowedTools is empty', () => {
      const result = buildClaudeArgs('msg', { allowedTools: [] })
      expect(result).not.toContain('--allowedTools')
    })

    it('should add --add-dir for each directory', () => {
      const result = buildClaudeArgs('msg', { addDirs: ['/tmp/dir1', '/tmp/dir2'] })
      expect(result.filter((a) => a === '--add-dir')).toHaveLength(2)
      expect(result).toContain('/tmp/dir1')
      expect(result).toContain('/tmp/dir2')
    })

    it('should not include --add-dir when addDirs is empty', () => {
      const result = buildClaudeArgs('msg', { addDirs: [] })
      expect(result).not.toContain('--add-dir')
    })

    it('should add Japanese locale prompt', () => {
      const result = buildClaudeArgs('msg', { locale: 'ja' })
      const promptIdx = result.indexOf('--append-system-prompt')
      expect(promptIdx).toBeGreaterThan(-1)
      expect(result[promptIdx + 1]).toContain('Japanese')
    })

    it('should add English locale prompt', () => {
      const result = buildClaudeArgs('msg', { locale: 'en' })
      const promptIdx = result.indexOf('--append-system-prompt')
      expect(promptIdx).toBeGreaterThan(-1)
      expect(result[promptIdx + 1]).toContain('English')
    })

    it('should add --mcp-config when mcpConfigPath is provided', () => {
      const result = buildClaudeArgs('msg', { mcpConfigPath: '/tmp/mcp.json' })
      expect(result).toContain('--mcp-config')
      const idx = result.indexOf('--mcp-config')
      expect(result[idx + 1]).toBe('/tmp/mcp.json')
    })

    it('should add --strict-mcp-config when strictMcpConfig is true', () => {
      const result = buildClaudeArgs('msg', { strictMcpConfig: true })
      expect(result).toContain('--strict-mcp-config')
    })

    it('should not add --strict-mcp-config when strictMcpConfig is false or omitted', () => {
      expect(buildClaudeArgs('msg', { strictMcpConfig: false })).not.toContain('--strict-mcp-config')
      expect(buildClaudeArgs('msg')).not.toContain('--strict-mcp-config')
    })

    it('should add --strict-mcp-config without --mcp-config when only strictMcpConfig is set (Slack Marketplace shape)', () => {
      const result = buildClaudeArgs('msg', { strictMcpConfig: true, tools: ['Read', 'Grep', 'Glob'] })
      expect(result).toContain('--strict-mcp-config')
      expect(result).not.toContain('--mcp-config')
    })

    it('should include file_upload instruction in system prompt when mcpConfigPath is provided', () => {
      const result = buildClaudeArgs('msg', { mcpConfigPath: '/tmp/mcp.json' })
      const promptIdx = result.indexOf('--append-system-prompt')
      expect(promptIdx).toBeGreaterThan(-1)
      expect(result[promptIdx + 1]).toContain('file_upload')
      expect(result[promptIdx + 1]).toContain('CRITICAL FILE DELIVERY RULE')
    })

    it('should combine locale and systemPrompt separated by double newline', () => {
      const result = buildClaudeArgs('msg', {
        locale: 'ja',
        systemPrompt: 'Do something specific.',
      })
      const promptIdx = result.indexOf('--append-system-prompt')
      const prompt = result[promptIdx + 1]
      expect(prompt).toContain('Japanese')
      expect(prompt).toContain('Do something specific.')
      expect(prompt).toContain('\n\n')
    })

    it('should not add --append-system-prompt when no locale/systemPrompt/mcpConfigPath', () => {
      const result = buildClaudeArgs('msg')
      expect(result).not.toContain('--append-system-prompt')
    })

    it('should place message as last argument', () => {
      const result = buildClaudeArgs('final-message', {
        allowedTools: ['Bash'],
        addDirs: ['/tmp'],
        locale: 'en',
        mcpConfigPath: '/tmp/mcp.json',
        systemPrompt: 'instructions',
      })
      expect(result[result.length - 1]).toBe('final-message')
    })
  })

  describe('buildClaudeArgs - pluginDir', () => {
    it('should add --plugin-dir when pluginDir is provided', () => {
      const result = buildClaudeArgs('msg', { pluginDir: '/opt/app/dist/plugin' })
      expect(result).toContain('--plugin-dir')
      const idx = result.indexOf('--plugin-dir')
      expect(result[idx + 1]).toBe('/opt/app/dist/plugin')
    })

    it('should not include --plugin-dir when pluginDir is not provided', () => {
      const result = buildClaudeArgs('msg')
      expect(result).not.toContain('--plugin-dir')
    })

    it('should not include --plugin-dir when pluginDir is undefined', () => {
      const result = buildClaudeArgs('msg', { pluginDir: undefined })
      expect(result).not.toContain('--plugin-dir')
    })

    it('should place --plugin-dir before --model and keep message last', () => {
      const result = buildClaudeArgs('final-message', {
        pluginDir: '/opt/app/dist/plugin',
        model: 'claude-opus-4-8',
      })
      const pluginDirIdx = result.indexOf('--plugin-dir')
      const modelIdx = result.indexOf('--model')
      expect(pluginDirIdx).toBeGreaterThan(-1)
      expect(modelIdx).toBeGreaterThan(pluginDirIdx)
      expect(result[result.length - 1]).toBe('final-message')
    })
  })
})
