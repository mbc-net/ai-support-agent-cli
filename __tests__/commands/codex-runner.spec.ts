import os from 'os'

import { buildCodexArgs } from '../../src/commands/codex-runner'

describe('codex-runner', () => {
  describe('buildCodexArgs', () => {
    it('builds non-interactive JSONL args', () => {
      const args = buildCodexArgs('hello')

      expect(args.slice(0, -1)).toEqual([
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        'workspace-write',
      ])
      expect(args.at(-1)).toBe('hello')
    })

    it('does not pass unsupported approval flags to codex exec', () => {
      const args = buildCodexArgs('hello')

      expect(args).not.toContain('--ask-for-approval')
    })

    it('adds cwd, model, and add-dir options', () => {
      const args = buildCodexArgs('hello', {
        cwd: '/tmp/project',
        model: 'gpt-5-codex',
        addDirs: ['~/shared', '/tmp/other'],
        outputLastMessagePath: '/tmp/last-message.txt',
      })

      expect(args).toContain('--cd')
      expect(args[args.indexOf('--cd') + 1]).toBe('/tmp/project')
      expect(args).toContain('--model')
      expect(args[args.indexOf('--model') + 1]).toBe('gpt-5-codex')
      expect(args).toContain('--add-dir')
      expect(args).toContain(`${os.homedir()}/shared`)
      expect(args).toContain('/tmp/other')
      expect(args).toContain('--output-last-message')
      expect(args[args.indexOf('--output-last-message') + 1]).toBe('/tmp/last-message.txt')
    })

    it('prepends locale and system prompt to the user message', () => {
      const args = buildCodexArgs('hello', {
        locale: 'ja',
        systemPrompt: 'Custom instructions',
      })

      expect(args.at(-1)).toBe([
        'Always respond in Japanese. Use Japanese for all explanations and communications.',
        'Custom instructions',
        'hello',
      ].join('\n\n'))
    })
  })
})
