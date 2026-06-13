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
  })
})
