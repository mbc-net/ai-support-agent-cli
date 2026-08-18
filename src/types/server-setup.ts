/**
 * Server setup execution types (Ansible-driven server provisioning).
 *
 * A `server_setup_exec` command runs a recipe **body** — a top-level YAML list
 * of Ansible tasks authored by a tenant admin (built-in steps are expressed as
 * `include_role` tasks referencing the 6 bundled roles under `ansible/roles/`)
 * — against a single target host, using an SSH private key fetched
 * Just-In-Time from the API (never persisted beyond the lifetime of the
 * command). The agent generates the enclosing play
 * (`hosts`/`become`/`gather_facts`/inventory) itself so the caller can never
 * hijack it. See admin-docs
 * `docs/specifications/git-artifact-platform.md` for the full design.
 */

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

/**
 * Execution route of a `server_setup_exec` command, set authoritatively by the
 * api dispatch service (`ServerSetupDispatchService`). Kept in sync with the
 * api's `SERVER_SETUP_DISPATCH_MODES`:
 * - `ecs_oneshot`: 当社基盤（ECS Fargate ワンショット）— strict guard allowlist.
 * - `resident_agent`: 顧客の閉域ネットワークの常駐エージェント — lenient allowlist.
 */
export const SERVER_SETUP_DISPATCH_MODES = ['ecs_oneshot', 'resident_agent'] as const
export type ServerSetupDispatchMode = (typeof SERVER_SETUP_DISPATCH_MODES)[number]

/**
 * Payload of the `server_setup_exec` command (git-artifact-platform contract).
 *
 * `body` is the recipe body: a top-level YAML **list of Ansible tasks**. The
 * agent wraps it in a single generated play (fixed `hosts`/`become`/
 * `gather_facts`/inventory) — the caller never supplies play-level keys. The
 * previous `steps` array (per-step `stepType`/`params`/`customTasksYaml`) is
 * gone; built-in steps now appear inside `body` as `include_role` tasks.
 *
 * `dispatchMode` is the authoritative execution-route hint from the api. The
 * agent's `resolveRouteMode` prefers it over the local `AGENT_MODE` env when
 * choosing the guard's strict (`ecs`) / lenient (`resident`) allowlist, and
 * fails closed to `ecs` when it is absent or unknown. It is optional so a
 * payload from an older api build (which omits it) still parses — such a
 * payload simply falls back to the fail-closed env-derived decision.
 */
export interface ServerSetupExecPayload {
  executionId: string
  sshHostId: string
  body: string
  dispatchMode?: ServerSetupDispatchMode
}

/**
 * Result of a single Ansible task, parsed from the `ansible-playbook` JSON
 * callback output. Execution reporting is now **per task** (the previous
 * per-stepType grouping is gone): `name` is the task's own Ansible name.
 */
export interface ServerSetupTaskResult {
  name: string
  status: 'ok' | 'failed' | 'skipped'
  changed: boolean
  message: string
}

/**
 * The API's answer to an awaiting-self-restart declaration.
 *
 * A 200 only says the request was accepted: the api applies the flag on a
 * best-effort path and still answers 200 when it could not (a DB error, an
 * execution that terminated in the meantime). `acknowledged` is the only thing
 * that says the flag is actually set on the execution row — and this is the
 * last answer this process will ever read, because it restarts itself right
 * after.
 */
export interface SelfRestartDeclarationAck {
  acknowledged: boolean
  /**
   * Why, in the api's own vocabulary (`declared` / `already_declared` /
   * `not_found` / `already_terminal` / `error`). Carried through to the
   * execution log so an operator can tell a lost declaration from a race.
   */
  outcome?: string
}

/**
 * One mid-run progress event sent to the API while ansible is still running.
 *
 * `start` events carry only the task name (its outcome is not known yet);
 * `end` events additionally carry the same `status`/`changed`/`message` triple
 * as {@link ServerSetupTaskResult}. The mapping from raw Ansible host results
 * to that triple is done here in the agent (via the same `taskResultFrom` the
 * authoritative results use) rather than in the API, so Ansible's result
 * semantics have exactly one implementation.
 */
export interface ServerSetupProgressEvent {
  /** 1-based, monotonic within a run; assigned by the Ansible callback plugin. */
  seq: number
  phase: 'start' | 'end'
  name: string
  /** `end` only. */
  status?: ServerSetupTaskResult['status']
  /** `end` only. */
  changed?: boolean
  /** `end` only. */
  message?: string
}
