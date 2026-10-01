/** Shared contract: keep API and agent copies identical. Run only after task guard. */
export const SENTRY_CAPABILITY = 'server_setup_sentry_v1'
export type SentryOperation = 'install' | 'verify' | 'diagnose' | 'stop'
export function inspectSentryTasks(
  tasks: readonly Record<string, unknown>[],
): { operation: SentryOperation } | null {
  const matches = tasks.filter((task) => {
    const role = task['ansible.builtin.include_role'] ?? task.include_role
    return (
      role &&
      typeof role === 'object' &&
      (role as { name?: unknown }).name === 'sentry'
    )
  })
  if (!matches.length) return null
  if (matches.length !== 1)
    throw new Error('Sentry may occur only once per execution')
  const vars = matches[0].vars as Record<string, unknown> | undefined
  const operation = vars?.sentry_operation ?? 'install'
  if (
    !['install', 'verify', 'diagnose', 'stop'].includes(operation as string)
  ) {
    throw new Error(
      'sentry_operation must be a literal install, verify, diagnose or stop',
    )
  }
  if (operation !== 'install' && tasks.length !== 1)
    throw new Error('Sentry recovery/verification must run alone')
  return { operation: operation as SentryOperation }
}
