import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { buildReadOnlyToolSchemas, executeReadOnlyTool, globTool, grepTool, isDangerousRegexPattern } from '../../src/commands/api-tool-executor'
import { _terminateSharedWorker } from '../../src/commands/api-tool-worker-runner'
import {
  API_TOOL_GLOB_MAX_RESULTS,
  API_TOOL_GREP_MAX_LINE_CHARS,
  API_TOOL_GREP_MAX_MATCHES,
  API_TOOL_MAX_READABLE_FILE_BYTES,
  API_TOOL_READ_MAX_BYTES,
  API_TOOL_READ_MAX_LINES,
  API_TOOL_WORKER_TIMEOUT_MS,
} from '../../src/constants'

// NOTE on grepTool/globTool vs executeReadOnlyTool('Grep'|'Glob', ...):
// In production, Grep/Glob always run inside a pooled Worker thread (see
// api-tool-worker-runner.ts) when called through the public executeReadOnlyTool()
// entry point on the main thread. Coverage instrumentation running in the Jest
// process cannot observe code executed inside that separate thread's own V8
// isolate, so most functional/correctness tests below call the exported
// grepTool()/globTool() directly (same thread, fully covered, fast). A smaller,
// clearly-labeled set of tests specifically prove the Worker wiring itself
// (dispatch, ReDoS-timeout backstop, cancellation) via the real
// executeReadOnlyTool() path.

describe('api-tool-executor', () => {
  let tmpRoot: string
  let reposDir: string
  let docsDir: string
  let outsideDir: string

  afterAll(async () => {
    // A handful of tests below deliberately go through the real Worker (see the
    // NOTE above). Terminate the pooled Worker thread so it doesn't leak past
    // this test file.
    await _terminateSharedWorker()
  })

  beforeEach(() => {
    // Resolve the real path up front: on macOS os.tmpdir() lives under a
    // symlink (/var -> /private/var), and containPath() resolves everything
    // through fs.realpath for security. Without this, path strings built from
    // the un-resolved tmpRoot would never equal the resolved paths produced
    // by the walker, breaking string-equality assertions below.
    tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-tool-executor-')))
    reposDir = path.join(tmpRoot, 'workspace', 'repos')
    docsDir = path.join(tmpRoot, 'workspace', 'docs')
    fs.mkdirSync(reposDir, { recursive: true })
    fs.mkdirSync(docsDir, { recursive: true })
    outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-tool-executor-outside-')))
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  })

  describe('buildReadOnlyToolSchemas', () => {
    it('returns exactly Read/Grep/Glob with the expected required fields', () => {
      const schemas = buildReadOnlyToolSchemas()
      expect(schemas.map((s) => s.name)).toEqual(['Read', 'Grep', 'Glob'])
      expect(schemas.find((s) => s.name === 'Read')?.input_schema.required).toEqual(['file_path'])
      expect(schemas.find((s) => s.name === 'Grep')?.input_schema.required).toEqual(['pattern'])
      expect(schemas.find((s) => s.name === 'Glob')?.input_schema.required).toEqual(['pattern'])
    })
  })

  // ============================================================
  // Sandbox containment — this is the ONLY security boundary in api mode.
  // These cases must be covered first and exhaustively.
  // ============================================================
  describe('sandbox containment (security-critical)', () => {
    it('rejects Read of an absolute path entirely outside sandboxRoots', async () => {
      const secretFile = path.join(outsideDir, 'secret.txt')
      fs.writeFileSync(secretFile, 'top secret')

      const result = await executeReadOnlyTool('Read', { file_path: secretFile }, [reposDir, docsDir])

      expect(result.isError).toBe(true)
      expect(result.output).toContain('Access denied')
    })

    it('rejects Read of a path that escapes sandboxRoots via ".." traversal', async () => {
      const secretFile = path.join(outsideDir, 'secret.txt')
      fs.writeFileSync(secretFile, 'top secret')
      // Build a path that starts inside reposDir but walks out via '..'
      const relativeToOutside = path.relative(reposDir, outsideDir)
      const traversal = path.join(reposDir, relativeToOutside, 'secret.txt')

      const result = await executeReadOnlyTool('Read', { file_path: traversal }, [reposDir, docsDir])

      expect(result.isError).toBe(true)
      expect(result.output).toContain('Access denied')
    })

    it('rejects Read via a symlink inside sandboxRoots whose target is outside (symlink escape)', async () => {
      const secretFile = path.join(outsideDir, 'secret.txt')
      fs.writeFileSync(secretFile, 'top secret')
      const linkPath = path.join(reposDir, 'escape-link')
      fs.symlinkSync(secretFile, linkPath)

      const result = await executeReadOnlyTool('Read', { file_path: linkPath }, [reposDir, docsDir])

      expect(result.isError).toBe(true)
      expect(result.output).toContain('Access denied')
    })

    it('does not follow a symlinked directory that escapes sandboxRoots while walking for Grep', async () => {
      fs.mkdirSync(path.join(outsideDir, 'nested'))
      fs.writeFileSync(path.join(outsideDir, 'nested', 'leak.txt'), 'PASSWORD=hunter2')
      fs.symlinkSync(path.join(outsideDir, 'nested'), path.join(reposDir, 'linked-dir'))

      const result = await grepTool({ pattern: 'PASSWORD' }, [reposDir, docsDir])

      expect(result.isError).toBe(false)
      expect(result.output).not.toContain('PASSWORD')
      expect(result.output).toBe('No matches found')
    })

    it('does follow a symlinked directory that stays within sandboxRoots', async () => {
      const realDir = path.join(reposDir, 'real-dir')
      fs.mkdirSync(realDir)
      fs.writeFileSync(path.join(realDir, 'found.txt'), 'NEEDLE')
      fs.symlinkSync(realDir, path.join(reposDir, 'linked-in-sandbox'))

      const result = await grepTool({ pattern: 'NEEDLE' }, [reposDir, docsDir])

      expect(result.isError).toBe(false)
      // Matched at least via the real path (walking the symlink dir resolves
      // to the same real file, so exactly one match, not a duplicate).
      expect(result.output).toContain('NEEDLE')
    })

    it('rejects Glob when the path option points outside sandboxRoots', async () => {
      const result = await globTool({ pattern: '**/*', path: outsideDir }, [reposDir, docsDir])

      expect(result.isError).toBe(true)
      expect(result.output).toContain('Access denied')
    })

    it('rejects Grep when the path option points outside sandboxRoots', async () => {
      const result = await grepTool({ pattern: 'x', path: outsideDir }, [reposDir, docsDir])

      expect(result.isError).toBe(true)
      expect(result.output).toContain('Access denied')
    })

    it('rejects every tool when sandboxRoots is empty', async () => {
      const readResult = await executeReadOnlyTool('Read', { file_path: '/etc/passwd' }, [])
      const grepResult = await grepTool({ pattern: 'x' }, [])
      const globResult = await globTool({ pattern: '*' }, [])

      expect(readResult.isError).toBe(true)
      expect(readResult.output).toContain('No sandboxed directories')
      expect(grepResult.isError).toBe(true)
      expect(globResult.isError).toBe(true)
    })

    it('returns is_error (not a thrown exception) for a non-existent file', async () => {
      const result = await executeReadOnlyTool('Read', { file_path: path.join(reposDir, 'nope.txt') }, [reposDir, docsDir])

      expect(result.isError).toBe(true)
      expect(result.output).toContain('Path does not exist')
    })

    it('resolves relative file_path against the first sandbox root', async () => {
      fs.writeFileSync(path.join(reposDir, 'relative.txt'), 'hello')

      const result = await executeReadOnlyTool('Read', { file_path: 'relative.txt' }, [reposDir, docsDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain('hello')
    })

    it('does not throw when given malformed input (outer catch backstop)', async () => {
      const result = await executeReadOnlyTool('Read', null as unknown as Record<string, unknown>, [reposDir])

      expect(result.isError).toBe(true)
    })

    it('skips a sandboxRoot entry that does not exist on disk and still searches the valid ones', async () => {
      fs.writeFileSync(path.join(reposDir, 'a.txt'), 'MATCH here')
      const missingRoot = path.join(tmpRoot, 'does-not-exist')

      const result = await grepTool({ pattern: 'MATCH' }, [missingRoot, reposDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain('MATCH here')
    })

    it('follows a symlink that points at a file (not a directory) within sandboxRoots', async () => {
      fs.writeFileSync(path.join(reposDir, 'real.txt'), 'NEEDLE')
      fs.symlinkSync(path.join(reposDir, 'real.txt'), path.join(reposDir, 'link.txt'))

      const result = await grepTool({ pattern: 'NEEDLE' }, [reposDir, docsDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain(path.join(reposDir, 'link.txt'))
    })

    it('does not throw when given malformed input for Grep/Glob (outer catch backstop lives in executeReadOnlyTool, not grepTool/globTool themselves)', async () => {
      const grepResult = await executeReadOnlyTool('Grep', null as unknown as Record<string, unknown>, [reposDir])
      const globResult = await executeReadOnlyTool('Glob', null as unknown as Record<string, unknown>, [reposDir])
      expect(grepResult.isError).toBe(true)
      expect(globResult.isError).toBe(true)
    })
  })

  describe('Read', () => {
    it('returns file contents with 1-based line numbers', async () => {
      fs.writeFileSync(path.join(reposDir, 'file.txt'), 'line1\nline2\nline3')

      const result = await executeReadOnlyTool('Read', { file_path: path.join(reposDir, 'file.txt') }, [reposDir, docsDir])

      expect(result.isError).toBe(false)
      expect(result.output).toBe('1\tline1\n2\tline2\n3\tline3')
    })

    it('errors when file_path is missing', async () => {
      const result = await executeReadOnlyTool('Read', {}, [reposDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('file_path is required')
    })

    it('errors when the target path is a directory, not a file', async () => {
      const result = await executeReadOnlyTool('Read', { file_path: reposDir }, [reposDir, docsDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('not a file')
    })

    it('truncates output that exceeds the max line count', async () => {
      const totalLines = API_TOOL_READ_MAX_LINES + 50
      const content = Array.from({ length: totalLines }, (_, i) => `l${i}`).join('\n')
      fs.writeFileSync(path.join(reposDir, 'big.txt'), content)

      const result = await executeReadOnlyTool('Read', { file_path: path.join(reposDir, 'big.txt') }, [reposDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain('[Output truncated')
      expect(result.output).not.toContain(`${API_TOOL_READ_MAX_LINES + 1}\tl${API_TOOL_READ_MAX_LINES}`)
    })

    it('truncates output that exceeds the max byte size even with a single line', async () => {
      const huge = 'a'.repeat(API_TOOL_READ_MAX_BYTES + 10_000)
      fs.writeFileSync(path.join(reposDir, 'huge.txt'), huge)

      const result = await executeReadOnlyTool('Read', { file_path: path.join(reposDir, 'huge.txt') }, [reposDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain('[Output truncated')
      expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThan(API_TOOL_READ_MAX_BYTES + 200)
    })

    it('refuses to read a file larger than the pre-read size guard, without loading it into memory', async () => {
      const oversized = path.join(reposDir, 'oversized.bin')
      // API_TOOL_MAX_READABLE_FILE_BYTES (pre-read OOM guard) is much larger
      // than API_TOOL_READ_MAX_BYTES (post-read output truncation threshold);
      // this file must trip the former, not just the latter.
      fs.writeFileSync(oversized, Buffer.alloc(API_TOOL_MAX_READABLE_FILE_BYTES + 1024, 'x'))

      const result = await executeReadOnlyTool('Read', { file_path: oversized }, [reposDir])

      expect(result.isError).toBe(true)
      expect(result.output).toContain('too large')
    })

    // Skipped when running as root (e.g. some CI/Docker setups), where chmod
    // 0o000 does not actually block reads and the test would be a false pass.
    const maybeIt = process.getuid && process.getuid() === 0 ? it.skip : it
    maybeIt('returns is_error (not a thrown exception) when the file cannot be read due to permissions', async () => {
      const filePath = path.join(reposDir, 'no-read.txt')
      fs.writeFileSync(filePath, 'secret')
      fs.chmodSync(filePath, 0o000)
      try {
        const result = await executeReadOnlyTool('Read', { file_path: filePath }, [reposDir])
        expect(result.isError).toBe(true)
        expect(result.output).toContain('failed to read file')
      } finally {
        fs.chmodSync(filePath, 0o644)
      }
    })
  })

  describe('Grep (grepTool, direct — see NOTE at top of file)', () => {
    it('finds matches across nested directories within sandboxRoots', async () => {
      const nested = path.join(reposDir, 'nested', 'deep')
      fs.mkdirSync(nested, { recursive: true })
      fs.writeFileSync(path.join(nested, 'match.txt'), 'foo\nNEEDLE here\nbar')
      fs.writeFileSync(path.join(docsDir, 'other.txt'), 'no match')

      const result = await grepTool({ pattern: 'NEEDLE' }, [reposDir, docsDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain('NEEDLE here')
      expect(result.output).toContain(':2:')
    })

    it('searches across multiple sandbox roots', async () => {
      fs.writeFileSync(path.join(reposDir, 'a.txt'), 'MATCH in repos')
      fs.writeFileSync(path.join(docsDir, 'b.txt'), 'MATCH in docs')

      const result = await grepTool({ pattern: 'MATCH' }, [reposDir, docsDir])

      expect(result.output).toContain('MATCH in repos')
      expect(result.output).toContain('MATCH in docs')
    })

    it('restricts the search to a single file when path points at a file', async () => {
      fs.writeFileSync(path.join(reposDir, 'a.txt'), 'MATCH here')
      fs.writeFileSync(path.join(reposDir, 'b.txt'), 'MATCH there')

      const result = await grepTool({ pattern: 'MATCH', path: path.join(reposDir, 'a.txt') }, [reposDir, docsDir])

      expect(result.output).toContain('MATCH here')
      expect(result.output).not.toContain('MATCH there')
    })

    it('restricts the search to a directory when path points at a directory', async () => {
      fs.mkdirSync(path.join(reposDir, 'sub'))
      fs.writeFileSync(path.join(reposDir, 'sub', 'a.txt'), 'MATCH here')
      fs.writeFileSync(path.join(docsDir, 'b.txt'), 'MATCH there')

      const result = await grepTool({ pattern: 'MATCH', path: reposDir }, [reposDir, docsDir])

      expect(result.output).toContain('MATCH here')
      expect(result.output).not.toContain('MATCH there')
    })

    it('errors when the path option does not exist', async () => {
      const result = await grepTool({ pattern: 'x', path: path.join(reposDir, 'nope') }, [reposDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('does not exist')
    })

    it('filters files by the glob option', async () => {
      fs.writeFileSync(path.join(reposDir, 'a.ts'), 'MATCH ts')
      fs.writeFileSync(path.join(reposDir, 'b.md'), 'MATCH md')

      const result = await grepTool({ pattern: 'MATCH', glob: '*.ts' }, [reposDir, docsDir])

      expect(result.output).toContain('MATCH ts')
      expect(result.output).not.toContain('MATCH md')
    })

    it('errors on an invalid glob pattern', async () => {
      const result = await grepTool({ pattern: 'x', glob: '[' }, [reposDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('invalid glob pattern')
    })

    it('returns "No matches found" when nothing matches', async () => {
      fs.writeFileSync(path.join(reposDir, 'a.txt'), 'nothing interesting')
      const result = await grepTool({ pattern: 'NEEDLE' }, [reposDir, docsDir])
      expect(result.isError).toBe(false)
      expect(result.output).toBe('No matches found')
    })

    it('errors when pattern is missing', async () => {
      const result = await grepTool({}, [reposDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('pattern is required')
    })

    it('errors on an invalid regular expression pattern', async () => {
      const result = await grepTool({ pattern: '(' }, [reposDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('invalid regular expression')
    })

    it('caps results at the configured max match count and adds a truncation notice', async () => {
      const lines = Array.from({ length: API_TOOL_GREP_MAX_MATCHES + 50 }, () => 'MATCH').join('\n')
      fs.writeFileSync(path.join(reposDir, 'many.txt'), lines)

      const result = await grepTool({ pattern: 'MATCH' }, [reposDir])

      expect(result.isError).toBe(false)
      const matchLineCount = result.output.split('\n').filter((l) => l.startsWith(path.join(reposDir, 'many.txt'))).length
      expect(matchLineCount).toBe(API_TOOL_GREP_MAX_MATCHES)
      expect(result.output).toContain('[Results truncated')
    })

    it('truncates an individual matched line that is longer than the per-match length cap', async () => {
      const hugeLine = `NEEDLE-${'x'.repeat(API_TOOL_GREP_MAX_LINE_CHARS + 500)}`
      fs.writeFileSync(path.join(reposDir, 'longline.txt'), hugeLine)

      const result = await grepTool({ pattern: 'NEEDLE' }, [reposDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain('[line truncated]')
      // The full untruncated line must not appear verbatim in the output.
      expect(result.output).not.toContain(hugeLine)
      expect(result.output.length).toBeLessThan(hugeLine.length)
    })

    it('skips node_modules and .git directories while walking', async () => {
      fs.mkdirSync(path.join(reposDir, 'node_modules', 'pkg'), { recursive: true })
      fs.writeFileSync(path.join(reposDir, 'node_modules', 'pkg', 'index.js'), 'SECRET_TOKEN')
      fs.mkdirSync(path.join(reposDir, '.git'), { recursive: true })
      fs.writeFileSync(path.join(reposDir, '.git', 'config'), 'SECRET_TOKEN')

      const result = await grepTool({ pattern: 'SECRET_TOKEN' }, [reposDir])

      expect(result.output).toBe('No matches found')
    })

    const maybeItRoot = process.getuid && process.getuid() === 0 ? it.skip : it
    maybeItRoot('skips a subdirectory it cannot list (readdir EACCES) instead of failing the whole search', async () => {
      const lockedDir = path.join(reposDir, 'locked')
      fs.mkdirSync(lockedDir)
      fs.writeFileSync(path.join(lockedDir, 'a.txt'), 'MATCH inside locked dir')
      fs.writeFileSync(path.join(reposDir, 'readable.txt'), 'MATCH and readable')
      fs.chmodSync(lockedDir, 0o000)
      try {
        const result = await grepTool({ pattern: 'MATCH' }, [reposDir])
        expect(result.isError).toBe(false)
        expect(result.output).toContain('MATCH and readable')
      } finally {
        fs.chmodSync(lockedDir, 0o755)
      }
    })

    const maybeIt = process.getuid && process.getuid() === 0 ? it.skip : it
    maybeIt('skips a file it cannot read during the walk instead of failing the whole search', async () => {
      const unreadable = path.join(reposDir, 'no-read.txt')
      fs.writeFileSync(unreadable, 'MATCH but unreadable')
      fs.chmodSync(unreadable, 0o000)
      fs.writeFileSync(path.join(reposDir, 'readable.txt'), 'MATCH and readable')
      try {
        const result = await grepTool({ pattern: 'MATCH' }, [reposDir])
        expect(result.isError).toBe(false)
        expect(result.output).toContain('MATCH and readable')
        expect(result.output).not.toContain('unreadable')
      } finally {
        fs.chmodSync(unreadable, 0o644)
      }
    })

    it('skips a file larger than the pre-read size guard instead of loading it into memory, but still finds matches elsewhere', async () => {
      const oversized = path.join(reposDir, 'oversized.bin')
      // Embed the search term itself in the oversized file: if the size guard
      // did NOT skip it (i.e. the file were actually read and searched), this
      // match would show up in the output — proving the guard is what's
      // suppressing it, not mere absence of a match.
      const oversizedContent = 'MATCH\n' + 'x'.repeat(API_TOOL_MAX_READABLE_FILE_BYTES + 1024)
      fs.writeFileSync(oversized, oversizedContent)
      fs.writeFileSync(path.join(reposDir, 'normal.txt'), 'MATCH in a normal-sized file')

      const result = await grepTool({ pattern: 'MATCH' }, [reposDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain('MATCH in a normal-sized file')
      expect(result.output).not.toContain('oversized.bin')
    })

    // ============================================================
    // ReDoS (catastrophic backtracking) guard — security-critical.
    // Grep patterns can be LLM-generated from untrusted (Slack) input, so a
    // pathological pattern must never be allowed to hang the agent process.
    // ============================================================
    describe('ReDoS guard: static heuristic (grepTool, direct)', () => {
      // The classic exponential-blowup input for `(a+)+$`/`(a|a)+$`: a run of
      // 'a's long enough to demonstrate catastrophic backtracking, followed by
      // a character that prevents an easy match.
      const pathologicalLine = 'a'.repeat(30) + '!'

      it('rejects (a+)+$ against a pathological line instead of hanging, and does so quickly', async () => {
        fs.writeFileSync(path.join(reposDir, 'evil.txt'), pathologicalLine)

        const start = Date.now()
        const result = await grepTool({ pattern: '(a+)+$' }, [reposDir])
        const elapsedMs = Date.now() - start

        expect(result.isError).toBe(true)
        expect(result.output).toContain('catastrophic backtracking')
        // Proof this didn't fall through to a real (potentially hanging) regex
        // exec: the whole call, including the file walk, must complete near-instantly.
        expect(elapsedMs).toBeLessThan(1000)
      })

      it('rejects (a|a)+$ (ambiguous alternation) against a pathological line, quickly', async () => {
        fs.writeFileSync(path.join(reposDir, 'evil2.txt'), pathologicalLine)

        const start = Date.now()
        const result = await grepTool({ pattern: '(a|a)+$' }, [reposDir])
        const elapsedMs = Date.now() - start

        expect(result.isError).toBe(true)
        expect(elapsedMs).toBeLessThan(1000)
      })

      it('still executes ordinary, safe patterns normally (no false-positive regression)', async () => {
        fs.writeFileSync(path.join(reposDir, 'safe.txt'), 'error: something went wrong\nwarning: minor issue')

        const result = await grepTool({ pattern: 'error|warning' }, [reposDir])

        expect(result.isError).toBe(false)
        expect(result.output).toContain('error: something went wrong')
        expect(result.output).toContain('warning: minor issue')
      })
    })

    // ============================================================
    // ReDoS guard: Worker-thread timeout backstop — CRITICAL.
    // isDangerousRegexPattern() is a paren-nesting-only static heuristic — it
    // does NOT catch bracket-less consecutive quantifiers (confirmed below: it
    // returns false for this exact pattern). That gap is exactly why the real
    // safety net is the Worker-thread timeout (api-tool-worker-runner.ts), not
    // the static heuristic alone. Unlike the tests above, this one MUST go
    // through the real executeReadOnlyTool() -> Worker path: the whole point is
    // that the static guard is bypassed and grepTool() itself would genuinely
    // hang if called directly (there is nothing in grepTool() to stop it).
    // ============================================================
    describe('ReDoS guard: Worker timeout backstop (executeReadOnlyTool, real Worker)', () => {
      it(
        'falls back to the Worker timeout when a pattern bypasses the static heuristic entirely (bracket-less consecutive quantifiers)',
        async () => {
          const bypassPattern = 'a*'.repeat(20) + '!'
          expect(isDangerousRegexPattern(bypassPattern)).toBe(false) // confirms this really does bypass the static guard

          // Must NOT contain '!' — otherwise the engine matches greedily on its
          // first attempt with zero backtracking. Omitting the terminator forces
          // an exhaustive (exponential) search before concluding "no match".
          fs.writeFileSync(path.join(reposDir, 'evil.txt'), 'a'.repeat(35))

          const start = Date.now()
          const result = await executeReadOnlyTool('Grep', { pattern: bypassPattern }, [reposDir])
          const elapsedMs = Date.now() - start

          expect(result.isError).toBe(true)
          expect(result.output.toLowerCase()).toContain('timed out')
          // Real evidence of a timeout (not an instant static rejection): took
          // roughly the configured Worker timeout window...
          expect(elapsedMs).toBeGreaterThanOrEqual(API_TOOL_WORKER_TIMEOUT_MS - 200)
          // ...yet still bounded to a few seconds, nowhere near what the
          // pathological regex itself would take if left to run to completion.
          expect(elapsedMs).toBeLessThan(API_TOOL_WORKER_TIMEOUT_MS + 2000)
        },
        API_TOOL_WORKER_TIMEOUT_MS + 5000,
      )
    })

    describe('symlink cycle guard (walkFiles visited-set)', () => {
      it('Grep does not hang on a self-referential symlink (a/self -> a) and returns in bounded time (grepTool, direct)', async () => {
        const selfRefDir = path.join(reposDir, 'a')
        fs.mkdirSync(selfRefDir)
        fs.writeFileSync(path.join(selfRefDir, 'file.txt'), 'NEEDLE')
        fs.symlinkSync(selfRefDir, path.join(selfRefDir, 'self'))

        const start = Date.now()
        const result = await grepTool({ pattern: 'NEEDLE' }, [reposDir])
        const elapsedMs = Date.now() - start

        expect(result.isError).toBe(false)
        expect(result.output).toContain('NEEDLE')
        // The whole point: this must return near-instantly, proving the
        // visited-set cycle guard itself is what stopped it (this call bypasses
        // the Worker entirely, so there is no timeout backstop to fall back on).
        expect(elapsedMs).toBeLessThan(1000)
      })

      it('Grep does not hang on mutually-referential symlinks even when nothing matches (grepTool, direct)', async () => {
        const dirA = path.join(reposDir, 'a')
        const dirB = path.join(reposDir, 'b')
        fs.mkdirSync(dirA)
        fs.mkdirSync(dirB)
        fs.symlinkSync(dirB, path.join(dirA, 'link'))
        fs.symlinkSync(dirA, path.join(dirB, 'link'))

        const start = Date.now()
        const result = await grepTool({ pattern: 'NEEDLE' }, [reposDir])
        const elapsedMs = Date.now() - start

        expect(result.isError).toBe(false)
        expect(result.output).toBe('No matches found')
        expect(elapsedMs).toBeLessThan(1000)
      })

      // One end-to-end smoke test through the real Worker, proving the
      // visited-set fix also works correctly when the exact same code executes
      // inside the Worker thread (not just on the main thread) — dual coverage
      // of both the root fix (grepTool, above) and the production code path.
      it(
        'Glob does not hang on mutually-referential symlinks via the real Worker path (executeReadOnlyTool)',
        async () => {
          const dirA = path.join(reposDir, 'a')
          const dirB = path.join(reposDir, 'b')
          fs.mkdirSync(dirA)
          fs.mkdirSync(dirB)
          fs.writeFileSync(path.join(dirA, 'found.ts'), 'x')
          fs.symlinkSync(dirB, path.join(dirA, 'link'))
          fs.symlinkSync(dirA, path.join(dirB, 'link'))

          const start = Date.now()
          const result = await executeReadOnlyTool('Glob', { pattern: '**/*.ts' }, [reposDir])
          const elapsedMs = Date.now() - start

          expect(result.isError).toBe(false)
          expect(result.output).toContain('found.ts')
          // Must resolve well under the Worker timeout — proves the visited-set
          // guard (not the much slower timeout backstop) is what stopped it.
          expect(elapsedMs).toBeLessThan(API_TOOL_WORKER_TIMEOUT_MS)
        },
        API_TOOL_WORKER_TIMEOUT_MS + 5000,
      )
    })
  })

  describe('isDangerousRegexPattern (ReDoS static guard, whitebox)', () => {
    it.each([
      ['(a+)+$', true],
      ['(a|a)+$', true],
      ['(a*)*', true],
      ['((a+)+)+', true],
      ['(a+b)+', true],
      ['(a|ab)+c', true],
      ['(x{2,}){2,}', true],
    ])('flags %s as dangerous', (pattern, expected) => {
      expect(isDangerousRegexPattern(pattern)).toBe(expected)
    })

    it.each([
      ['error|warning', false],
      ['\\d{4}-\\d{2}-\\d{2}', false],
      ['(error|warning)', false],
      ['foo.*bar', false],
      ['(foo)+bar', false],
      ['(foo).*', false],
      ['a+(bc)+', false],
      ['[+*|]', false],
      ['\\(a\\+\\)\\+', false],
      ['simple search term', false],
    ])('does not flag %s (safe / linear pattern)', (pattern, expected) => {
      expect(isDangerousRegexPattern(pattern)).toBe(expected)
    })

    it('does not flag the bracket-less consecutive-quantifier bypass pattern (documents a known limitation)', () => {
      // This is the pattern class that necessitated the Worker-timeout backstop
      // (see the "ReDoS guard: Worker timeout backstop" describe block above).
      // isDangerousRegexPattern() only reasons about paren-nested quantifiers, so
      // bracket-less consecutive quantifiers slip through undetected.
      expect(isDangerousRegexPattern('a*'.repeat(20) + '!')).toBe(false)
    })

    it('does not crash on an unterminated brace (no closing "}" anywhere in the pattern)', () => {
      expect(isDangerousRegexPattern('a{')).toBe(false)
      expect(isDangerousRegexPattern('(a{)+')).toBe(false)
    })
  })

  describe('Glob (globTool, direct — see NOTE at top of file)', () => {
    it('finds files matching the pattern within sandboxRoots', async () => {
      fs.mkdirSync(path.join(reposDir, 'src'))
      fs.writeFileSync(path.join(reposDir, 'src', 'index.ts'), 'x')
      fs.writeFileSync(path.join(reposDir, 'readme.md'), 'x')

      const result = await globTool({ pattern: '**/*.ts' }, [reposDir, docsDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain(path.join(reposDir, 'src', 'index.ts'))
      expect(result.output).not.toContain('readme.md')
    })

    it('restricts the search to the path option when a directory is provided', async () => {
      fs.mkdirSync(path.join(reposDir, 'sub'))
      fs.writeFileSync(path.join(reposDir, 'sub', 'a.ts'), 'x')
      fs.writeFileSync(path.join(docsDir, 'b.ts'), 'x')

      const result = await globTool({ pattern: '*.ts', path: path.join(reposDir, 'sub') }, [reposDir, docsDir])

      expect(result.output).toContain('a.ts')
      expect(result.output).not.toContain('b.ts')
    })

    it('errors when the path option is a file, not a directory', async () => {
      fs.writeFileSync(path.join(reposDir, 'file.txt'), 'x')
      const result = await globTool({ pattern: '*', path: path.join(reposDir, 'file.txt') }, [reposDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('not a directory')
    })

    it('sorts results by most recently modified first', async () => {
      const older = path.join(reposDir, 'older.ts')
      const newer = path.join(reposDir, 'newer.ts')
      fs.writeFileSync(older, 'x')
      fs.writeFileSync(newer, 'x')
      const now = Date.now() / 1000
      fs.utimesSync(older, now - 1000, now - 1000)
      fs.utimesSync(newer, now, now)

      const result = await globTool({ pattern: '*.ts' }, [reposDir])

      const lines = result.output.split('\n')
      expect(lines.indexOf(newer)).toBeLessThan(lines.indexOf(older))
    })

    it('returns "No files found" when nothing matches', async () => {
      const result = await globTool({ pattern: '*.nonexistent-ext' }, [reposDir, docsDir])
      expect(result.isError).toBe(false)
      expect(result.output).toBe('No files found')
    })

    it('caps results at the configured max count and adds a truncation notice', async () => {
      const total = API_TOOL_GLOB_MAX_RESULTS + 20
      for (let i = 0; i < total; i++) {
        fs.writeFileSync(path.join(reposDir, `f${i}.ts`), 'x')
      }

      const result = await globTool({ pattern: '*.ts' }, [reposDir])

      expect(result.isError).toBe(false)
      expect(result.output).toContain('[Results truncated')
      const fileLines = result.output.split('\n').filter((l) => l.endsWith('.ts'))
      expect(fileLines.length).toBe(API_TOOL_GLOB_MAX_RESULTS)
    })

    it('errors when pattern is missing', async () => {
      const result = await globTool({}, [reposDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('pattern is required')
    })

    it('errors on an invalid glob pattern', async () => {
      const result = await globTool({ pattern: '[' }, [reposDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('invalid glob pattern')
    })
  })

  describe('executeReadOnlyTool (public dispatch entry point)', () => {
    it('returns is_error for an unknown tool name', async () => {
      const result = await executeReadOnlyTool('Bash', { command: 'ls' }, [reposDir])
      expect(result.isError).toBe(true)
      expect(result.output).toContain('unknown tool')
    })

    it('dispatches Grep to the same result grepTool() would produce directly (wiring sanity check)', async () => {
      fs.writeFileSync(path.join(reposDir, 'a.txt'), 'NEEDLE here')

      const viaWorker = await executeReadOnlyTool('Grep', { pattern: 'NEEDLE' }, [reposDir])
      const direct = await grepTool({ pattern: 'NEEDLE' }, [reposDir])

      expect(viaWorker).toEqual(direct)
    })

    it('dispatches Glob to the same result globTool() would produce directly (wiring sanity check)', async () => {
      fs.writeFileSync(path.join(reposDir, 'a.ts'), 'x')

      const viaWorker = await executeReadOnlyTool('Glob', { pattern: '*.ts' }, [reposDir])
      const direct = await globTool({ pattern: '*.ts' }, [reposDir])

      expect(viaWorker).toEqual(direct)
    })
  })

  describe('executeReadOnlyTool worker re-entrancy guard (isMainThread === false)', () => {
    // When executeReadOnlyTool() is called from INSIDE the Worker thread itself
    // (the Worker's bootstrap calls it to actually run grepTool/globTool), it must
    // NOT try to spawn yet another nested Worker — it should fall through to
    // calling grepTool/globTool directly. Simulate that by mocking
    // worker_threads.isMainThread to false in an isolated module registry.
    it('calls grepTool/globTool directly instead of spawning a nested Worker', async () => {
      let isolated: typeof import('../../src/commands/api-tool-executor') | undefined

      await jest.isolateModulesAsync(async () => {
        jest.doMock('worker_threads', () => {
          const actual = jest.requireActual('worker_threads')
          return { ...actual, isMainThread: false }
        })
        isolated = await import('../../src/commands/api-tool-executor')
      })

      fs.writeFileSync(path.join(reposDir, 'a.txt'), 'NEEDLE here')
      const grepResult = await isolated!.executeReadOnlyTool('Grep', { pattern: 'NEEDLE' }, [reposDir])
      expect(grepResult.isError).toBe(false)
      expect(grepResult.output).toContain('NEEDLE here')

      fs.writeFileSync(path.join(reposDir, 'a.ts'), 'x')
      const globResult = await isolated!.executeReadOnlyTool('Glob', { pattern: '*.ts' }, [reposDir])
      expect(globResult.isError).toBe(false)
      expect(globResult.output).toContain('a.ts')
    })
  })
})
