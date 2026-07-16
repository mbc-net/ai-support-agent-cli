/**
 * Static analysis tests for the bundled Dockerfile.
 *
 * Reads the actual committed Dockerfile (no fs mocking) to verify that
 * required OS packages are present. A failing test here means the image built
 * from the Dockerfile would be missing a capability at runtime.
 *
 * Note: .local/Dockerfile is gitignored (local development only) and is not
 * tested here.
 */

import * as fs from 'fs'
import * as path from 'path'

const PRODUCTION_DOCKERFILE = path.resolve(__dirname, '../../docker/Dockerfile')

function readDockerfile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

describe('Dockerfile content validation', () => {
  describe('docker/Dockerfile (production)', () => {
    let content: string

    beforeAll(() => {
      content = readDockerfile(PRODUCTION_DOCKERFILE)
    })

    it('should install fonts-noto-cjk for Japanese character rendering in Playwright Chromium', () => {
      // Chromium inside the container uses system fonts. Without CJK fonts,
      // Japanese characters on web pages render as squares or wrong glyphs.
      expect(content).toContain('fonts-noto-cjk')
    })

    describe('backlog-mcp-server pnpm-only preinstall guard', () => {
      // backlog-mcp-server@0.13.0 added `preinstall: npx only-allow pnpm`,
      // which aborts `npm install` (exit 254 / npx ENOENT in a fresh Docker
      // layer). The guard is a footgun from the maintainer's npm->pnpm
      // dev-workflow migration — the README still tells consumers to run it via
      // `npx backlog-mcp-server`. Installing it on the plain `npm install -g`
      // line therefore breaks the whole image build. It must be installed:
      //  - with `--ignore-scripts` (skips the guard; the package ships
      //    pre-built with no needed install/postinstall scripts at 0.13.0),
      //  - PINNED to an exact version, so `--ignore-scripts` stays scoped to a
      //    verified release rather than silently skipping a future version's
      //    legitimately-needed lifecycle script, and
      //  - on its OWN command so the other global packages keep their scripts.

      // Packages that must stay on a normal (scripts-enabled) install.
      const PROTECTED_PACKAGES = [
        '@anthropic-ai/claude-code',
        '@openai/codex',
        '@ai-support-agent/cli',
      ]

      let npmInstallCommands: string[]

      beforeAll(() => {
        // Reduce the Dockerfile to individual shell commands so each
        // `npm install` invocation is asserted on its own:
        //  1. strip `#` comment lines (the workaround is explained inline inside
        //     the RUN block; BuildKit strips such comments before running), so
        //     comment prose doesn't pollute the code assertions;
        //  2. join backslash line-continuations into single logical lines;
        //  3. split on `&&` — the CLI install and the backlog install are two
        //     separate `npm install` commands chained within one RUN.
        npmInstallCommands = content
          .split('\n')
          .filter((line) => !line.trim().startsWith('#'))
          .join('\n')
          .replace(/\\\r?\n\s*/g, ' ')
          .split('\n')
          .flatMap((line) => line.split('&&'))
          .map((cmd) => cmd.trim())
          .filter((cmd) => cmd.includes('npm install'))
      })

      // Match the bare `--ignore-scripts` flag on a shell-token boundary so
      // `--ignore-scripts=false` (which does NOT disable scripts) is not a
      // false positive.
      const hasIgnoreScripts = (cmd: string): boolean =>
        /(?:^|\s)--ignore-scripts(?:\s|$)/.test(cmd)

      // Match the `backlog-mcp-server` package token (optionally `@version`) on
      // a token boundary so a similarly-named package isn't a false positive.
      const installsBacklog = (cmd: string): boolean =>
        /(?:^|\s)backlog-mcp-server(?:@\S+)?(?:\s|$)/.test(cmd)

      it('installs backlog-mcp-server pinned to an exact version with --ignore-scripts to bypass the pnpm-only preinstall guard', () => {
        const backlogInstalls = npmInstallCommands.filter(installsBacklog)
        expect(backlogInstalls.length).toBeGreaterThan(0)
        for (const cmd of backlogInstalls) {
          expect(hasIgnoreScripts(cmd)).toBe(true)
          // Exact version pin (x.y.z): keeps --ignore-scripts scoped to a
          // verified release. An unpinned install would let a future version's
          // needed lifecycle script be silently skipped.
          expect(cmd).toMatch(/(?:^|\s)backlog-mcp-server@\d+\.\d+\.\d+(?:\s|$)/)
        }
      })

      it('keeps every other global app package on a normal install (scripts enabled), separate from backlog-mcp-server', () => {
        for (const pkg of PROTECTED_PACKAGES) {
          const installCmd = npmInstallCommands.find((cmd) => cmd.includes(pkg))
          expect(installCmd).toBeDefined()
          // Must not disable scripts (these packages may rely on their install
          // scripts) and must not carry backlog-mcp-server in the same
          // invocation (which would re-introduce the guard failure).
          expect(hasIgnoreScripts(installCmd as string)).toBe(false)
          expect(installsBacklog(installCmd as string)).toBe(false)
        }
      })

      it('smoke-checks the backlog-mcp-server binary at build time so a broken/incomplete install fails the build loudly', () => {
        // With --ignore-scripts a future version needing a real postinstall
        // could otherwise ship broken silently. Running the CLI (which exits 0)
        // right after install makes such breakage fail the Docker build.
        const normalized = content.replace(/\\\r?\n\s*/g, ' ')
        expect(normalized).toMatch(/backlog-mcp-server --version/)
      })
    })

    describe('apt-get update retry on transient network/DNS failure', () => {
      // Transient DNS/network hiccups against deb.debian.org make a single
      // `apt-get update` failure abort the whole build. Every occurrence must
      // retry with backoff instead of running bare.
      const BARE_RETRY_CHAIN =
        'apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update)'
      const KEYRING_REFRESH_FLAGS =
        '--allow-insecure-repositories -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false'
      const KEYRING_REFRESH_RETRY_CHAIN =
        `apt-get update ${KEYRING_REFRESH_FLAGS} || (sleep 5 && apt-get update ${KEYRING_REFRESH_FLAGS}) || (sleep 15 && apt-get update ${KEYRING_REFRESH_FLAGS}) || true`

      let normalized: string

      beforeAll(() => {
        // Join backslash line-continuations and collapse whitespace so the
        // assertions don't depend on the Dockerfile's line-wrapping/indentation.
        normalized = content
          .replace(/\\\r?\n/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      })

      it('retries the main OS packages, MSSQL tools, and gh/glab final apt-get update (3 attempts, 5s/15s backoff)', () => {
        const occurrences = normalized.split(BARE_RETRY_CHAIN).length - 1
        expect(occurrences).toBe(3)
      })

      it('retries the GitHub/GitLab CLI keyring-refresh apt-get update while preserving the tolerant `|| true` fallback', () => {
        expect(normalized).toContain(KEYRING_REFRESH_RETRY_CHAIN)
      })

      it('does not leave any apt-get update call without a retry chain', () => {
        // 4 locations x 3 attempts (1 initial + 2 retries) each = 12.
        // Strip comment lines first: the Dockerfile mentions "apt-get update"
        // in comments ("reduce apt-get update calls", "before apt-get update").
        const codeOnly = content
          .split('\n')
          .filter((line) => !line.trim().startsWith('#'))
          .join('\n')
        const totalUpdateCalls = (codeOnly.match(/apt-get update\b/g) || []).length
        expect(totalUpdateCalls).toBe(12)
      })
    })
  })
})
