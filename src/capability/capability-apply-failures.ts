import type { AgentCapabilityKey } from '../types'

/**
 * Failures observed while actually applying a capability in this process.
 *
 * Process-scoped on purpose: what these record is the state of a *process-wide*
 * resource (the guacd container this agent process started, or failed to
 * start). Two projects served by the same process share it.
 *
 * :::warning 「試した結果」であって「宣言」ではない
 * ここに載るのは、適用を試みて失敗した事実だけである。報告では
 * `not_applied(apply_failed)` になり、利用者には「エージェントのログを確認する」
 * 導線が出る。自動で粘って再試行はしない（Docker 不在のような恒久的な原因では
 * 無限に繰り返すだけになる）。再試行は利用者の明示操作——次の接続要求——で起きる。
 * :::
 */
const failures = new Map<AgentCapabilityKey, string>()

/**
 * Record why applying `key` failed.
 *
 * `detail` is surfaced in the admin UI, so callers must pass a diagnostic
 * message only — never a credential, a token or a connection parameter.
 */
export function recordCapabilityApplyFailure(
  key: AgentCapabilityKey,
  detail: string,
): void {
  failures.set(key, detail)
}

/** Forget a recorded failure (the capability was applied successfully). */
export function clearCapabilityApplyFailure(key: AgentCapabilityKey): void {
  failures.delete(key)
}

/** Snapshot of the recorded failures, for the heartbeat report. */
export function getCapabilityApplyFailures(): Partial<
  Record<AgentCapabilityKey, string>
> {
  return Object.fromEntries(failures) as Partial<
    Record<AgentCapabilityKey, string>
  >
}

/** Test seam: drop every recorded failure. */
export function resetCapabilityApplyFailures(): void {
  failures.clear()
}
