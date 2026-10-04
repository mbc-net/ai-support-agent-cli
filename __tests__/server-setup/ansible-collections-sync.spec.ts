/**
 * The Ansible Galaxy collections are pinned in two places that must agree:
 * the production image (docker/Dockerfile, `ansible-galaxy collection install`)
 * and local dev / CI (ansible/requirements.yml, used by ansible-roles.yml).
 * The Windows collections are additionally pinned in the guard data
 * (src/server-setup/windows-guard.json `collections`), whose argument
 * allowlists were surveyed against exactly those versions
 * (admin-docs server-setup-windows-openssh.md §5.6 / §6.1).
 */

import { readFileSync } from 'fs'
import * as path from 'path'

import { load } from 'js-yaml'

import { WINDOWS_COLLECTION_VERSIONS } from '../../src/server-setup/ansible-task-guard'

const ROOT = path.join(__dirname, '..', '..')

function dockerfileCollections(): Record<string, string> {
  const dockerfile = readFileSync(path.join(ROOT, 'docker', 'Dockerfile'), 'utf8')
  const match = dockerfile.match(/RUN ansible-galaxy collection install \\\n([\s\S]*?)\n\s+-p \/usr\/share\/ansible\/collections/)
  if (!match) throw new Error('ansible-galaxy collection install layer not found in docker/Dockerfile')
  const result: Record<string, string> = {}
  for (const spec of match[1].matchAll(/'([a-z0-9_]+\.[a-z0-9_]+):([^']+)'/g)) {
    result[spec[1]] = spec[2]
  }
  return result
}

function requirementsCollections(): Record<string, string> {
  const doc = load(readFileSync(path.join(ROOT, 'ansible', 'requirements.yml'), 'utf8')) as {
    collections: Array<{ name: string; version: string }>
  }
  return Object.fromEntries(doc.collections.map((c) => [c.name, c.version]))
}

describe('Ansible collection pins', () => {
  it('docker/Dockerfile and ansible/requirements.yml pin the same collections and versions', () => {
    const docker = dockerfileCollections()
    expect(Object.keys(docker).length).toBeGreaterThanOrEqual(5)
    expect(docker).toEqual(requirementsCollections())
  })

  it('pins the Windows collections to exactly the versions in windows-guard.json', () => {
    expect(WINDOWS_COLLECTION_VERSIONS).toEqual({ 'ansible.windows': '3.8.0', 'community.windows': '3.3.0' })
    const docker = dockerfileCollections()
    const requirements = requirementsCollections()
    for (const [name, version] of Object.entries(WINDOWS_COLLECTION_VERSIONS)) {
      expect(docker[name]).toBe(version)
      expect(requirements[name]).toBe(version)
    }
  })

  // The runner fails a Windows run on any other installed version and tells the
  // operator to run this exact command (asserted verbatim in
  // server-setup-runner.spec.ts); the manual-verification steps must give the same one.
  it('ansible/DEVELOPING.md installs the Windows collections with the same forced command as the runner error', () => {
    const developing = readFileSync(path.join(ROOT, 'ansible', 'DEVELOPING.md'), 'utf8')
    const specs = Object.entries(WINDOWS_COLLECTION_VERSIONS).map(([name, version]) => `${name}:${version}`)
    const command = `ansible-galaxy collection install --force ${specs.join(' ')}`
    expect(command).toBe('ansible-galaxy collection install --force ansible.windows:3.8.0 community.windows:3.3.0')
    expect(developing).toContain(command)
    // No other (unforced / ==-pinned) install command for the Windows collections remains.
    const windowsInstallLines = developing
      .split('\n')
      .filter((line) => line.includes('ansible-galaxy collection install') && line.includes('.windows'))
    expect(windowsInstallLines.map((line) => line.trim())).toEqual([command])
  })
})
