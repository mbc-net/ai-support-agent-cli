/**
 * Structural validation for the bundled Claude Code plugin at src/plugin.
 *
 * This is a mechanical safety net, not a translation-quality check: it
 * catches missing files, broken plugin.json/hooks.json, missing exec bits on
 * hook scripts, accidentally-included excluded sources, and leftover
 * Japanese/MBC-internal wording that a translation pass missed. It cannot
 * verify that the English prose reads naturally — that is a human review
 * concern (see docs/history and the code-review pass for this feature).
 */

import * as fs from 'fs'
import * as path from 'path'

const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'src', 'plugin')

const EXPECTED_AGENTS = [
  'planner',
  'code-reviewer',
  'typescript-reviewer',
  'python-reviewer',
  'php-reviewer',
  'react-reviewer',
  'nextjs-reviewer',
  'django-reviewer',
  'ui-reviewer',
  'infra-reviewer',
  'silent-failure-hunter',
  'investigator',
  'build-error-resolver',
]

const EXPECTED_COMMANDS = [
  'plan',
  'code-review',
  'add-feature',
  'fix-defect',
  'build-fix',
  'test-coverage',
  'update-docs',
  'learn',
  'learn-eval',
]

const EXPECTED_SKILLS = [
  'api-design',
  'backend-patterns',
  'database-migrations',
  'docker-patterns',
  'docs-site',
  'e2e-testing',
  'frontend-patterns',
  'integration-testing',
]

const EXPECTED_RULE_FILES = [
  'common/coding-guidelines.md',
  'documentation/api-docs.md',
  'documentation/docs-site.md',
  'documentation/source-docs.md',
  'documentation/test-docs.md',
  'logging/logging-rules.md',
  'php/coding-rules.md',
  'python/coding-rules.md',
  'typescript/coding-rules.md',
]

const EXPECTED_HOOK_SCRIPTS = [
  'guard-dangerous-commands.sh',
  'check-secrets-before-commit.sh',
  'protect-sensitive-files.sh',
  'auto-format.sh',
  'on-command-stop.sh',
  'on-command-resume.sh',
]

const RESUMABLE_COMMANDS = ['plan', 'add-feature', 'fix-defect']

/** Parses a leading `---\n...\n---` YAML-ish frontmatter block into a flat key/value map. */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  const fields: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/)
    if (kv) fields[kv[1]] = kv[2]
  }
  return fields
}

/** Detects Japanese characters (Hiragana/Katakana/CJK) that would indicate a missed translation. */
function containsJapanese(text: string): boolean {
  return /[぀-ヿ一-鿿]/.test(text)
}

describe('bundled plugin structure (src/plugin)', () => {
  it('has a plugin root directory', () => {
    expect(fs.existsSync(PLUGIN_ROOT)).toBe(true)
  })

  describe('.claude-plugin/plugin.json', () => {
    const pluginJsonPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')

    it('exists and is valid JSON', () => {
      expect(fs.existsSync(pluginJsonPath)).toBe(true)
      expect(() => JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'))).not.toThrow()
    })

    it('declares name "ai-support-agent" and an MIT license', () => {
      const json = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'))
      expect(json.name).toBe('ai-support-agent')
      expect(json.license).toBe('MIT')
    })

    it('does not ship a marketplace.json (not needed for --plugin-dir loading)', () => {
      expect(fs.existsSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json'))).toBe(false)
    })
  })

  describe('agents/', () => {
    it.each(EXPECTED_AGENTS)('%s.md exists with name + description frontmatter', (agentName) => {
      const filePath = path.join(PLUGIN_ROOT, 'agents', `${agentName}.md`)
      expect(fs.existsSync(filePath)).toBe(true)
      const frontmatter = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'))
      expect(frontmatter).not.toBeNull()
      expect(frontmatter?.name).toBe(agentName)
      expect(frontmatter?.description?.length ?? 0).toBeGreaterThan(0)
    })
  })

  describe('commands/', () => {
    it.each(EXPECTED_COMMANDS)('%s.md exists with description frontmatter', (commandName) => {
      const filePath = path.join(PLUGIN_ROOT, 'commands', `${commandName}.md`)
      expect(fs.existsSync(filePath)).toBe(true)
      const frontmatter = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'))
      expect(frontmatter).not.toBeNull()
      expect(frontmatter?.description?.length ?? 0).toBeGreaterThan(0)
    })

    it('excludes support.md (depends on MBC-internal Backlog/Slack/Notion/Sentry MCP tools)', () => {
      expect(fs.existsSync(path.join(PLUGIN_ROOT, 'commands', 'support.md'))).toBe(false)
    })
  })

  describe('skills/', () => {
    it.each(EXPECTED_SKILLS)('%s/SKILL.md exists with name + description frontmatter', (skillName) => {
      const filePath = path.join(PLUGIN_ROOT, 'skills', skillName, 'SKILL.md')
      expect(fs.existsSync(filePath)).toBe(true)
      const frontmatter = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'))
      expect(frontmatter).not.toBeNull()
      expect(frontmatter?.name).toBe(skillName)
      expect(frontmatter?.description?.length ?? 0).toBeGreaterThan(0)
    })
  })

  describe('hooks/', () => {
    const hooksJsonPath = path.join(PLUGIN_ROOT, 'hooks', 'hooks.json')

    it('hooks.json exists and is valid JSON', () => {
      expect(fs.existsSync(hooksJsonPath)).toBe(true)
      expect(() => JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'))).not.toThrow()
    })

    it('hooks.json references scripts via ${CLAUDE_PLUGIN_ROOT}, not absolute/local paths', () => {
      const raw = fs.readFileSync(hooksJsonPath, 'utf-8')
      expect(raw).toContain('${CLAUDE_PLUGIN_ROOT}')
      expect(raw).not.toContain('/Users/')
    })

    it.each(EXPECTED_HOOK_SCRIPTS)('%s exists and is executable', (scriptName) => {
      const scriptPath = path.join(PLUGIN_ROOT, 'hooks', 'scripts', scriptName)
      expect(fs.existsSync(scriptPath)).toBe(true)
      // eslint-disable-next-line no-bitwise
      expect(() => fs.accessSync(scriptPath, fs.constants.X_OK)).not.toThrow()
    })

    it('registers on-command-resume.sh under UserPromptSubmit and on-command-stop.sh under Stop', () => {
      const hooks = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf-8'))
      expect(hooks.hooks.UserPromptSubmit).toBeDefined()
      expect(hooks.hooks.Stop).toBeDefined()

      const userPromptSubmitRaw = JSON.stringify(hooks.hooks.UserPromptSubmit)
      const stopRaw = JSON.stringify(hooks.hooks.Stop)
      expect(userPromptSubmitRaw).toContain('on-command-resume.sh')
      expect(stopRaw).toContain('on-command-stop.sh')
    })
  })

  describe('resumable commands (plan.md / add-feature.md / fix-defect.md)', () => {
    it.each(RESUMABLE_COMMANDS)('%s.md declares resumable: true in frontmatter', (commandName) => {
      const filePath = path.join(PLUGIN_ROOT, 'commands', `${commandName}.md`)
      const frontmatter = parseFrontmatter(fs.readFileSync(filePath, 'utf-8'))
      expect(frontmatter).not.toBeNull()
      expect(frontmatter?.resumable).toBe('true')
    })

    it.each(RESUMABLE_COMMANDS)('%s.md contains a paired RESUME_DIGEST_START/RESUME_DIGEST_END block', (commandName) => {
      const filePath = path.join(PLUGIN_ROOT, 'commands', `${commandName}.md`)
      const content = fs.readFileSync(filePath, 'utf-8')
      expect(content).toContain('RESUME_DIGEST_START')
      expect(content).toContain('RESUME_DIGEST_END')
    })
  })

  describe('rules/', () => {
    it.each(EXPECTED_RULE_FILES)('%s exists', (relativePath) => {
      expect(fs.existsSync(path.join(PLUGIN_ROOT, 'rules', relativePath))).toBe(true)
    })

    it('excludes mbc-cqrs-serverless rules (framework-specific, not generally applicable)', () => {
      expect(fs.existsSync(path.join(PLUGIN_ROOT, 'rules', 'mbc-cqrs-serverless'))).toBe(false)
    })
  })

  describe('top-level metadata files', () => {
    it.each(['README.md', 'LICENSE', 'SYNC.md'])('%s exists at the plugin root', (fileName) => {
      expect(fs.existsSync(path.join(PLUGIN_ROOT, fileName))).toBe(true)
    })

    it('README.md credits the mbc-net/mbc-claude-code source', () => {
      const readme = fs.readFileSync(path.join(PLUGIN_ROOT, 'README.md'), 'utf-8')
      expect(readme).toContain('mbc-net/mbc-claude-code')
    })

    it('SYNC.md records the source commit SHA it was ported from', () => {
      const sync = fs.readFileSync(path.join(PLUGIN_ROOT, 'SYNC.md'), 'utf-8')
      expect(sync).toMatch(/[0-9a-f]{7,40}/)
    })
  })

  describe('translation completeness (mechanical check, not a prose-quality check)', () => {
    function walkMarkdownFiles(dir: string): string[] {
      if (!fs.existsSync(dir)) return []
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      return entries.flatMap((entry) => {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) return walkMarkdownFiles(fullPath)
        return entry.name.endsWith('.md') ? [fullPath] : []
      })
    }

    it('contains no leftover Japanese text outside of source attribution', () => {
      const files = walkMarkdownFiles(PLUGIN_ROOT)
      const offenders = files.filter((filePath) => {
        const content = fs.readFileSync(filePath, 'utf-8')
        // Attribution lines legitimately name the Japanese-named source repo;
        // strip known attribution phrasing before scanning for stray Japanese.
        const withoutAttribution = content.replace(/mbc-net\/mbc-claude-code/g, '')
        return containsJapanese(withoutAttribution)
      })
      expect(offenders).toEqual([])
    })
  })
})
