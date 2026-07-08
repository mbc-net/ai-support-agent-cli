import * as fs from 'fs'
import * as path from 'path'

describe('package files', () => {
  it('includes the Playwright subprocess config used by the packaged CLI', () => {
    const packageJsonPath = path.join(__dirname, '..', 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      files?: string[]
    }

    expect(packageJson.files).toContain('playwright.subprocess.config.ts')
  })
})
