/**
 * Server setup execution types (Ansible-driven server provisioning).
 *
 * A `server_setup_exec` command runs a fixed set of Ansible roles (bundled
 * with the agent CLI under `ansible/`) against a single target host, using
 * an SSH private key fetched Just-In-Time from the API (never persisted
 * beyond the lifetime of the command). See admin-docs
 * `docs/features/server-setup.md` for the full design.
 */

/** stepType supported by the bundled `ansible/playbook.yml` roles (MVP scope). */
export type ServerSetupStepType = 'os_init' | 'docker' | 'web_server' | 'database' | 'dns_tls'

/** One step of a server setup execution: an Ansible role selected by tag, with its variables. */
export interface ServerSetupStep {
  stepType: ServerSetupStepType
  params: Record<string, string>
}

/** Payload of the `server_setup_exec` command. */
export interface ServerSetupExecPayload {
  executionId: string
  sshHostId: string
  steps: ServerSetupStep[]
}

/** Result of a single step, parsed from the `ansible-playbook` JSON callback output. */
export interface ServerSetupStepResult {
  stepType: string
  status: 'ok' | 'failed' | 'skipped'
  changed: boolean
  message: string
}
