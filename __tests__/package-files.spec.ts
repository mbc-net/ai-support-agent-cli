import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Runs the real `npm pack` (dry-run) to list exactly what ships in the
 * published tarball — package.json's `files` field alone isn't enough to
 * assert this, since exclusions can also come from `.npmignore`.
 */
function packedFilePaths(): string[] {
  const output = execSync('npm pack --dry-run --json', {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf-8',
  })
  const [{ files }] = JSON.parse(output) as [{ files: Array<{ path: string }> }]
  return files.map((f) => f.path)
}

describe('package files', () => {
  it('includes the JavaScript Playwright subprocess config used by the packaged CLI', () => {
    const packageJsonPath = path.join(__dirname, '..', 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
      files?: string[]
    }

    expect(packageJson.files).toContain('playwright.subprocess.config.js')
    expect(packageJson.files).not.toContain('playwright.subprocess.config.ts')
  })

  // Regression: agent/ansible/callback_plugins/tests/test_json_callback.py is
  // a dev-only unit test for the bundled json.py callback plugin. Because
  // package.json's `files` field lists the whole `ansible` directory with no
  // exclusion, it was shipped inside the published tarball (and therefore
  // the Docker image's node_modules/@ai-support-agent/cli/ansible/). At
  // runtime, server-setup-runner.ts points Ansible's ANSIBLE_CALLBACK_PLUGINS
  // at the whole callback_plugins/ directory, so Ansible scans this test
  // file as a callback plugin candidate and logs a confusing
  // "[WARNING]: Skipping plugin (.../tests/test_json_callback.py) as it
  // seems to be invalid" on every server_setup_exec run.
  it('excludes dev-only test fixtures under ansible/callback_plugins/tests from the packed npm tarball', () => {
    const files = packedFilePaths()

    expect(files).toContain('ansible/callback_plugins/json.py')
    expect(files.some((f) => f.startsWith('ansible/callback_plugins/tests/'))).toBe(false)
  })
})
