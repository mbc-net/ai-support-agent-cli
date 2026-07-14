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

/**
 * カスタムAnsibleタスクの適用方式。
 *
 * - `append`: 標準タスク（bundled role）の後にカスタムタスクを追加実行する
 * - `replace`: 当該ステップの標準タスクをカスタムタスクで置き換える
 *
 * api側 `ServerSetupCustomTaskMode`（api/src/types/server-setup.ts 相当）と
 * 完全に同期させること。設計: admin-docs/docs/features/server-setup.md
 * 「カスタムAnsibleタスク」節。
 */
export type ServerSetupCustomTaskMode = 'append' | 'replace'

/**
 * One step of a server setup execution: an Ansible role selected by tag, with
 * its variables.
 *
 * `customTasksYaml`/`customTasksMode` carry a tenant admin's custom Ansible
 * tasks (validated server-side by `ansible-task-guard.ts`'s
 * `validateCustomTasksYaml` — both at api save-time and, authoritatively,
 * again by the agent before execution). See
 * `src/server-setup/ansible-task-guard.ts` and
 * `src/server-setup/server-setup-runner.ts`'s `validatePayload`.
 */
export interface ServerSetupStep {
  stepType: ServerSetupStepType
  params: Record<string, string>
  customTasksYaml?: string
  customTasksMode?: ServerSetupCustomTaskMode
}

/**
 * Response of the `GET commands/:id/server-setup-variables` JIT fetch:
 * project (`ANSIBLE#`-prefixed `ConfigSetting`) variables to inject into
 * `extra-vars.json`, plus the subset of variable names that are `kind:
 * 'secret'`. `secretNames` drives both `no_log: true` annotation
 * (`ansible-task-guard.ts`'s `referencesSecretVar`) and post-execution
 * redaction of stdout/stderr/step messages (see
 * `server-setup-runner.ts`'s `fetchServerSetupVariables` and redaction
 * logic) — the last line of defense if `no_log` was somehow not applied.
 */
export interface ServerSetupVariablesResponse {
  variables: Record<string, string>
  secretNames: string[]
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
