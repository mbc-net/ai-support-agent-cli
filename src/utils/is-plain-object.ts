/**
 * Returns true when `value` is a non-null, non-array object (a "plain" object
 * whose top level can be indexed by string keys).
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
