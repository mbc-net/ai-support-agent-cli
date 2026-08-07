/**
 * POSIX shell single-quote a value so it can be safely interpolated into a
 * bash script. Wraps the value in single quotes and escapes any embedded
 * single quote as `'\''`. The result is always exactly one shell argument.
 *
 * Lives here (a leaf util) rather than in `cli/service/wrapper-helpers.ts` so
 * that `terminal/` can share it without a `terminal/` → `cli/service/`
 * layering inversion. `wrapper-helpers.ts` re-exports it for existing callers.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
