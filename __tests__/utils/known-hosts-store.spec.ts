/**
 * Tests for src/utils/known-hosts-store.ts
 *
 * Covers the persistence behavior that item #4 of the code review fixes:
 * the known_hosts file used for `StrictHostKeyChecking=accept-new` (TOFU)
 * must be namespaced per (tenantCode, sshHostId) and REUSED across separate
 * calls/runs — not recreated empty every time — so a host-key change is
 * actually detectable on a later run instead of every run looking like a
 * "first use".
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const TEST_DIR_NAME = '.ai-support-agent-test-known-hosts-' + process.pid
const TEST_CONFIG_DIR = path.join(os.tmpdir(), TEST_DIR_NAME)

// Isolate CONFIG_DIR the same way __tests__/config-manager.spec.ts does, so
// this test never touches the real ~/.ai-support-agent.
jest.mock('../../src/constants', () => {
  const actual = jest.requireActual('../../src/constants')
  return {
    ...actual,
    CONFIG_DIR: '.ai-support-agent-test-known-hosts-' + process.pid,
  }
})

jest.mock('os', () => {
  const originalOs = jest.requireActual('os')
  return {
    ...originalOs,
    homedir: () => require('os').tmpdir(),
  }
})

import { knownHostsDir, resolveKnownHostsPath } from '../../src/utils/known-hosts-store'

describe('known-hosts-store', () => {
  afterEach(() => {
    if (fs.existsSync(TEST_CONFIG_DIR)) {
      fs.rmSync(TEST_CONFIG_DIR, { recursive: true, force: true })
    }
  })

  it('creates the known-hosts directory under the persistent config dir', () => {
    resolveKnownHostsPath('acme', 'host-1')

    const dir = knownHostsDir()
    expect(dir).toBe(path.join(TEST_CONFIG_DIR, 'server-setup', 'known-hosts'))
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('creates an empty 0600 file the first time a tenant/host pair is seen', () => {
    const filePath = resolveKnownHostsPath('acme', 'host-1')

    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('')
    // 0600: not secret, but kept as restrictive as the rest of this
    // directory's contents (private key, extra-vars.json).
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
  })

  it('reuses (does not truncate) the same file across repeated calls for the same tenant/host', () => {
    const firstPath = resolveKnownHostsPath('acme', 'host-1')
    // Simulate ssh having recorded a host key on the first "run".
    fs.writeFileSync(firstPath, '203.0.113.10 ssh-ed25519 AAAAC3Nz...\n')

    const secondPath = resolveKnownHostsPath('acme', 'host-1')

    expect(secondPath).toBe(firstPath)
    // Not wiped back to empty — this is the whole point of TOFU actually
    // working across runs.
    expect(fs.readFileSync(secondPath, 'utf-8')).toContain('203.0.113.10 ssh-ed25519')
  })

  it('gives different tenants distinct known_hosts files for the same sshHostId', () => {
    const acmePath = resolveKnownHostsPath('acme', 'host-1')
    const otherPath = resolveKnownHostsPath('globex', 'host-1')

    expect(acmePath).not.toBe(otherPath)
  })

  it('gives different sshHostIds distinct known_hosts files for the same tenant', () => {
    const hostOnePath = resolveKnownHostsPath('acme', 'host-1')
    const hostTwoPath = resolveKnownHostsPath('acme', 'host-2')

    expect(hostOnePath).not.toBe(hostTwoPath)
  })

  it('sanitizes tenantCode/sshHostId into a safe filename (no path traversal, no unexpected characters)', () => {
    const filePath = resolveKnownHostsPath('Acme Corp', '../../etc/passwd')

    // Resolved path must stay inside the known-hosts directory — a
    // sshHostId containing `../` must not escape it.
    expect(path.dirname(filePath)).toBe(knownHostsDir())
    expect(path.basename(filePath)).toMatch(/^[a-z0-9-]+__[a-z0-9-]+$/)
  })
})
