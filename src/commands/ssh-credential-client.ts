/**
 * JIT SSH credential lookup used by the `ssh_exec` command handler (see
 * `commands/index.ts`).
 *
 * Thin wrapper around `ApiClient.getSshExecCredential`: the target host's
 * connection parameters (hostname/port/username/authType/privateKey, and —
 * when `connectionType === 'tailscale'` — tailnetHostname/socksPort, see
 * `SshExecCredential`) are resolved server-side from the command's payload
 * and fetched fresh for each execution, never cached or persisted by the
 * agent CLI.
 *
 * The api-side `ssh_exec` credential endpoint is implemented in a later
 * phase (admin-docs `docs/specifications/ssh-tailscale-support.md`: "api側
 * の実装は別フェーズ(フェーズA/D)で拡張される"); this module only depends on
 * the commandId-scoped fetch contract, not on any specific field beyond the
 * base `SshCredentials` shape being present.
 *
 * SECURITY: the resolved credential (private key / password /
 * `tailscaleAuthKey`) must never be logged. Only the commandId is logged.
 */

import type { ApiClient } from '../api-client'
import type { SshExecCredential } from '../types'
import { getErrorMessage } from '../utils'

/**
 * Fetch the SSH connection parameters for a single `ssh_exec` command.
 * Failures are re-thrown with context but never include the underlying
 * error's raw payload (which could echo back request data).
 */
export async function fetchSshExecCredential(
  client: ApiClient,
  commandId: string,
  agentId: string,
): Promise<SshExecCredential> {
  try {
    return await client.getSshExecCredential(commandId, agentId)
  } catch (error) {
    throw new Error(`Failed to fetch SSH credential: ${getErrorMessage(error)}`)
  }
}
