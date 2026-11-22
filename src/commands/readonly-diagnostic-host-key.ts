/**
 * Host-key pin for the readonly_diagnostic command.
 *
 * The JIT credential is resolved from an asset-ledger connection, which has no
 * host-key fingerprint field. Server setup against the same asset already
 * pinned the host key (TOFU) in its persistent known_hosts file, namespaced by
 * (tenantCode, sshHostId) where sshHostId is the asset UID (the api's
 * execution target id; `ServerSetupAssetCredential.hostId`). This module reads
 * that pin — never creating the file and never accepting a new key — so the
 * SSH connection is strictly verified.
 */
import type { SshExecCredential } from '../types'
import { readPinnedHostKey } from '../utils/known-hosts-pin'
import { knownHostsFilePath } from '../utils/known-hosts-store'
import { createSshHostVerifier } from '../utils/ssh-host-key'

const DEFAULT_SSH_PORT = 22
const HOST_RE = /^[^\s,[\]]+$/

export const READONLY_DIAGNOSTIC_NOT_PINNED =
  'readonly_diagnostic rejected: host key is not pinned for this asset; run a server setup recipe against it first'

export type ReadonlyDiagnosticHostKey =
  | { ok: true; credential: SshExecCredential; hostKeyAlgorithms?: string[] }
  /** `reason` is a fixed code safe to log; `error` is the user-facing result. */
  | { ok: false; reason: string; error: string }

function reject(reason: string, error: string): ReadonlyDiagnosticHostKey {
  return { ok: false, reason, error }
}

export async function resolveReadonlyDiagnosticHostKey(
  credential: SshExecCredential,
  assetUid: string,
  tenantCode: string,
): Promise<ReadonlyDiagnosticHostKey> {
  if (credential.hostId !== assetUid) {
    return reject('credential_asset_mismatch', 'readonly_diagnostic rejected: credential does not belong to this asset')
  }

  const provided: unknown = credential.hostKeyFingerprint
  if (provided !== undefined && provided !== null && provided !== '') {
    try {
      createSshHostVerifier(provided)
    } catch {
      return reject('host_key_fingerprint_malformed', 'readonly_diagnostic rejected: credential host key fingerprint is malformed')
    }
    return { ok: true, credential }
  }

  // Same host string server setup's inventory hands to ssh (`ansible_host`):
  // the tailnet hostname for tailscale, the ledger hostname otherwise.
  const host = credential.connectionType === 'tailscale' ? credential.tailnetHostname : credential.hostname
  const port = credential.port || DEFAULT_SSH_PORT
  if (typeof host !== 'string' || !HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return reject('credential_host_invalid', 'readonly_diagnostic rejected: credential host or port is invalid')
  }
  if (!tenantCode) {
    return reject('tenant_code_missing', READONLY_DIAGNOSTIC_NOT_PINNED)
  }

  let pinned: Awaited<ReturnType<typeof readPinnedHostKey>>
  try {
    pinned = await readPinnedHostKey(knownHostsFilePath(tenantCode, assetUid), host, port)
  } catch {
    return reject('host_key_unreadable', 'readonly_diagnostic rejected: the pinned host key for this asset could not be read')
  }
  if (!pinned.ok) {
    return pinned.reason === 'ambiguous'
      ? reject(
          'host_key_ambiguous',
          'readonly_diagnostic rejected: several different host keys are pinned for this asset; remove the stale entry from its server-setup known_hosts file',
        )
      : reject('host_key_not_pinned', READONLY_DIAGNOSTIC_NOT_PINNED)
  }
  return {
    ok: true,
    credential: { ...credential, hostKeyFingerprint: pinned.fingerprint },
    hostKeyAlgorithms: pinned.hostKeyAlgorithms,
  }
}
