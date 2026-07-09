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
