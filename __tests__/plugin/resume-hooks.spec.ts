/**
 * Behavioral tests for the ai-support-agent-specific resume hooks:
 *
 * - hooks/scripts/on-command-stop.sh (Stop hook): detects a
 *   `<!-- ai-support-agent:resume name="..." --> ` marker at the end of the
 *   last assistant transcript entry and persists/prunes per-conversation
 *   resume state under ~/.ai-support-agent/plugin-resume/.
 * - hooks/scripts/on-command-resume.sh (UserPromptSubmit hook): reads that
 *   state and, if still within the turn budget, re-injects the target
 *   command's Resume Digest as additionalContext.
 *
 * These scripts are invoked directly as subprocesses (not through `claude`),
 * with HOME redirected to a fresh temp directory per test so state files
 * never touch the real user home.
 */

import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'src', 'plugin')
const STOP_SCRIPT = path.join(PLUGIN_ROOT, 'hooks', 'scripts', 'on-command-stop.sh')
const RESUME_SCRIPT = path.join(PLUGIN_ROOT, 'hooks', 'scripts', 'on-command-resume.sh')

function stateFilePath(homeDir: string, conversationId: string): string {
  const sanitized = conversationId.replace(/[^A-Za-z0-9._-]/g, '')
  return path.join(homeDir, '.ai-support-agent', 'plugin-resume', `${sanitized}.json`)
}

function writeTranscript(dir: string, entries: unknown[]): string {
  const transcriptPath = path.join(dir, 'transcript.jsonl')
  fs.writeFileSync(transcriptPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
  return transcriptPath
}

function assistantEntry(text: string): unknown {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text }],
    },
  }
}

function runStopHook(
  homeDir: string,
  transcriptPath: string,
  opts: { conversationId?: string | undefined } = {},
): { status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir }
  if (opts.conversationId === undefined) {
    delete env.AI_SUPPORT_CONVERSATION_ID
  } else {
    env.AI_SUPPORT_CONVERSATION_ID = opts.conversationId
  }
  const result = execFileSync('bash', [STOP_SCRIPT], {
    input: JSON.stringify({ transcript_path: transcriptPath }),
    env,
    encoding: 'utf-8',
  })
  return { status: 0, stdout: result } as unknown as { status: number | null }
}

function runResumeHook(
  homeDir: string,
  opts: { conversationId?: string | undefined } = {},
): string {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeDir, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT }
  if (opts.conversationId === undefined) {
    delete env.AI_SUPPORT_CONVERSATION_ID
  } else {
    env.AI_SUPPORT_CONVERSATION_ID = opts.conversationId
  }
  const result = execFileSync('bash', [RESUME_SCRIPT], {
    input: JSON.stringify({}),
    env,
    encoding: 'utf-8',
  })
  return result
}

describe('resume hooks (src/plugin/hooks/scripts)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-hooks-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('on-command-stop.sh', () => {
    it('creates state file with turns=1, misses=0 when the marker is present in the last assistant entry', () => {
      const conversationId = 'conv-abc-123'
      const transcriptPath = writeTranscript(tmpDir, [
        assistantEntry('Some earlier turn, no marker here.'),
        { type: 'user', message: { content: [{ type: 'text', text: 'go ahead' }] } },
        assistantEntry(
          'Plan drafted, waiting for approval.\n<!-- ai-support-agent:resume name="add-feature" -->',
        ),
      ])

      runStopHook(tmpDir, transcriptPath, { conversationId })

      const statePath = stateFilePath(tmpDir, conversationId)
      expect(fs.existsSync(statePath)).toBe(true)
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      expect(state.command).toBe('add-feature')
      expect(state.turns).toBe(1)
      expect(state.misses).toBe(0)
    })

    it('increments turns to 2 on a second run with the same conversation and command', () => {
      const conversationId = 'conv-repeat-1'
      const transcriptPath = writeTranscript(tmpDir, [
        assistantEntry('<!-- ai-support-agent:resume name="add-feature" -->'),
      ])

      runStopHook(tmpDir, transcriptPath, { conversationId })
      runStopHook(tmpDir, transcriptPath, { conversationId })

      const statePath = stateFilePath(tmpDir, conversationId)
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      expect(state.command).toBe('add-feature')
      expect(state.turns).toBe(2)
      expect(state.misses).toBe(0)
    })

    it('keeps the state file and sets misses=1 when no marker is found for the first time (grace period)', () => {
      const conversationId = 'conv-miss-first-1'
      const statePath = stateFilePath(tmpDir, conversationId)
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      fs.writeFileSync(
        statePath,
        JSON.stringify({ command: 'add-feature', turns: 3, misses: 0 }),
        'utf-8',
      )

      const transcriptPath = writeTranscript(tmpDir, [
        assistantEntry('Still working on it, forgot the marker this time.'),
      ])

      runStopHook(tmpDir, transcriptPath, { conversationId })

      expect(fs.existsSync(statePath)).toBe(true)
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      expect(state.command).toBe('add-feature')
      expect(state.turns).toBe(3)
      expect(state.misses).toBe(1)
    })

    it('deletes an existing state file when no marker is found for a second consecutive time (misses already 1)', () => {
      const conversationId = 'conv-complete-1'
      const statePath = stateFilePath(tmpDir, conversationId)
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      fs.writeFileSync(
        statePath,
        JSON.stringify({ command: 'add-feature', turns: 3, misses: 1 }),
        'utf-8',
      )

      const transcriptPath = writeTranscript(tmpDir, [
        assistantEntry('All done. Implementation complete and committed.'),
      ])

      runStopHook(tmpDir, transcriptPath, { conversationId })

      expect(fs.existsSync(statePath)).toBe(false)
    })

    it('resets misses to 0 and increments turns when the marker reappears after a prior miss', () => {
      const conversationId = 'conv-miss-recover-1'
      const statePath = stateFilePath(tmpDir, conversationId)
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      fs.writeFileSync(
        statePath,
        JSON.stringify({ command: 'add-feature', turns: 3, misses: 1 }),
        'utf-8',
      )

      const transcriptPath = writeTranscript(tmpDir, [
        assistantEntry('Back on track.\n<!-- ai-support-agent:resume name="add-feature" -->'),
      ])

      runStopHook(tmpDir, transcriptPath, { conversationId })

      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'))
      expect(state.command).toBe('add-feature')
      expect(state.turns).toBe(4)
      expect(state.misses).toBe(0)
    })

    it('does nothing when AI_SUPPORT_CONVERSATION_ID is unset', () => {
      const transcriptPath = writeTranscript(tmpDir, [
        assistantEntry('<!-- ai-support-agent:resume name="plan" -->'),
      ])

      runStopHook(tmpDir, transcriptPath, { conversationId: undefined })

      const resumeDir = path.join(tmpDir, '.ai-support-agent', 'plugin-resume')
      expect(fs.existsSync(resumeDir)).toBe(false)
    })

    it('treats a marker inside a fenced code block as NOMATCH (no false positive)', () => {
      const conversationId = 'conv-fenced-1'
      const transcriptPath = writeTranscript(tmpDir, [
        assistantEntry(
          [
            'To signal an incomplete flow, end your response with a line like:',
            '```',
            '<!-- ai-support-agent:resume name="plan" -->',
            '```',
            'That is just an illustrative example, not a real resume marker.',
          ].join('\n'),
        ),
      ])

      runStopHook(tmpDir, transcriptPath, { conversationId })

      const statePath = stateFilePath(tmpDir, conversationId)
      expect(fs.existsSync(statePath)).toBe(false)
    })

    it('prunes state files older than 24h for any conversation, regardless of the current run', () => {
      const staleConversationId = 'conv-stale-1'
      const stalePath = stateFilePath(tmpDir, staleConversationId)
      fs.mkdirSync(path.dirname(stalePath), { recursive: true })
      fs.writeFileSync(stalePath, JSON.stringify({ command: 'fix-defect', turns: 1 }), 'utf-8')
      const old = Date.now() / 1000 - 25 * 60 * 60
      fs.utimesSync(stalePath, old, old)

      const currentConversationId = 'conv-current-1'
      const transcriptPath = writeTranscript(tmpDir, [assistantEntry('No marker, nothing special.')])

      runStopHook(tmpDir, transcriptPath, { conversationId: currentConversationId })

      expect(fs.existsSync(stalePath)).toBe(false)
    })

    it('deletes a corrupted (unparseable) state file when no marker is found (self-heal)', () => {
      const conversationId = 'conv-corrupt-1'
      const statePath = stateFilePath(tmpDir, conversationId)
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      fs.writeFileSync(statePath, '{invalid json', 'utf-8')

      const transcriptPath = writeTranscript(tmpDir, [assistantEntry('No marker, nothing special.')])

      runStopHook(tmpDir, transcriptPath, { conversationId })

      expect(fs.existsSync(statePath)).toBe(false)
    })

    it('does nothing when no state file exists at all and no marker is found', () => {
      const conversationId = 'conv-no-state-1'
      const statePath = stateFilePath(tmpDir, conversationId)

      const transcriptPath = writeTranscript(tmpDir, [assistantEntry('No marker, nothing special.')])

      runStopHook(tmpDir, transcriptPath, { conversationId })

      expect(fs.existsSync(statePath)).toBe(false)
    })
  })

  describe('on-command-resume.sh', () => {
    function writeState(homeDir: string, conversationId: string, state: unknown): void {
      const statePath = stateFilePath(homeDir, conversationId)
      fs.mkdirSync(path.dirname(statePath), { recursive: true })
      fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8')
    }

    it('emits additionalContext containing content from add-feature.md Resume Digest when turns is within budget', () => {
      const conversationId = 'conv-resume-1'
      writeState(tmpDir, conversationId, { command: 'add-feature', turns: 2 })

      const stdout = runResumeHook(tmpDir, { conversationId })

      const parsed = JSON.parse(stdout)
      expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
      expect(typeof parsed.hookSpecificOutput.additionalContext).toBe('string')
      expect(parsed.hookSpecificOutput.additionalContext).toContain('Commit gate')
    })

    it('appends a PROTOCOL REMINDER with the completion marker example after the Resume Digest content', () => {
      const conversationId = 'conv-resume-reminder-1'
      writeState(tmpDir, conversationId, { command: 'add-feature', turns: 2, misses: 0 })

      const stdout = runResumeHook(tmpDir, { conversationId })

      const parsed = JSON.parse(stdout)
      const additionalContext: string = parsed.hookSpecificOutput.additionalContext
      expect(additionalContext).toContain('Commit gate')
      expect(additionalContext).toContain('PROTOCOL REMINDER')
      expect(additionalContext).toContain('<!-- ai-support-agent:resume name="add-feature" -->')

      const digestIndex = additionalContext.indexOf('Commit gate')
      const reminderIndex = additionalContext.indexOf('PROTOCOL REMINDER')
      expect(reminderIndex).toBeGreaterThan(digestIndex)
    })

    it('deletes the state file and produces no hookSpecificOutput when turns exceeds the safety-valve limit', () => {
      const conversationId = 'conv-runaway-1'
      writeState(tmpDir, conversationId, { command: 'add-feature', turns: 7 })

      const stdout = runResumeHook(tmpDir, { conversationId })

      const statePath = stateFilePath(tmpDir, conversationId)
      expect(fs.existsSync(statePath)).toBe(false)
      expect(stdout).not.toContain('hookSpecificOutput')
    })

    it('produces no stdout output when no state file exists', () => {
      const conversationId = 'conv-none-1'

      const stdout = runResumeHook(tmpDir, { conversationId })

      expect(stdout.trim()).toBe('')
    })

    it('deletes the state file and produces no hookSpecificOutput when turns is a non-int type (self-heal)', () => {
      const conversationId = 'conv-bad-turns-type-1'
      writeState(tmpDir, conversationId, { command: 'add-feature', turns: '7' })

      const stdout = runResumeHook(tmpDir, { conversationId })

      const statePath = stateFilePath(tmpDir, conversationId)
      expect(fs.existsSync(statePath)).toBe(false)
      expect(stdout).not.toContain('hookSpecificOutput')
    })
  })
})
