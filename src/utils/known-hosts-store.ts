/**
 * Persistent, per-SSH-host known_hosts file for TOFU (Trust On First Use)
 * host key checking, shared across every subsystem that performs
 * git-over-ssh operations: server-setup, repo-sync, git-credential-setup,
 * and terminal-session.
 *
 * Unlike the SSH private key (fetched Just-In-Time and always removed with
 * the rest of the per-run temp directory — see `server-setup-runner.ts`), a
 * known_hosts entry is NOT secret: it only records the target host's public
 * key fingerprint. Volatilizing it alongside the private key on every run
 * defeats TOFU's entire purpose: `StrictHostKeyChecking=accept-new` only
 * rejects a *changed* host key on a *later* connection if there is a
 * *previously recorded* one to compare against. Starting from an empty file
 * on every run means every run looks like a "first use", so a later
 * DNS/route hijack presenting a different host key is silently accepted
 * instead of rejected.
 *
 * This file is stored under the agent CLI's persistent config directory
 * (`getConfigDir()`, e.g. `~/.ai-support-agent`), namespaced by tenantCode
 * and sshHostId so distinct tenants/hosts never share (or clobber) each
 * other's recorded host keys, and reused across every run against the same
 * host.
 */
import * as fs from 'fs'
import * as path from 'path'

import { getConfigDir } from '../config-manager'
import { ensureDir, sanitizeNameSegment } from '../utils'

/**
 * 接続先ホストが呼び出し時点で判明しない経路専用の共有 sshHostId。
 * terminal-session の対話シェル、git-credential-setup の未登録ホストへの
 * フォールバック等で使う。sanitizeNameSegment 通過後も 'shared' のまま。
 */
export const GENERAL_KNOWN_HOSTS_ID = 'shared'

/** Directory (under the persistent config dir) holding one known_hosts file per (tenantCode, sshHostId) pair. */
export function knownHostsDir(): string {
  return path.join(getConfigDir(), 'server-setup', 'known-hosts')
}

/**
 * Resolve (and ensure exists) the persistent known_hosts file path for a
 * given tenant/host pair.
 *
 * Creates an empty file (mode 0600 — not secret, but kept restrictive like
 * the rest of this directory's contents) the first time a given tenant/host
 * pair is seen; that first run is TOFU's legitimate "trust on first use".
 * Every subsequent run against the same host reuses (and lets `ssh` append
 * to) the same file, so a later host-key change is detected — via ssh's own
 * `StrictHostKeyChecking=accept-new` behavior — rather than silently
 * accepted.
 */
export function resolveKnownHostsPath(tenantCode: string, sshHostId: string): string {
  const dir = knownHostsDir()
  ensureDir(dir, 0o700)

  const fileName = `${sanitizeNameSegment(tenantCode)}__${sanitizeNameSegment(sshHostId)}`
  const filePath = path.join(dir, fileName)
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', { mode: 0o600 })
  }
  return filePath
}
