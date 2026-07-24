/**
 * Replace every occurrence of each (non-empty) secret value with `***` in
 * `text`. Belt-and-suspenders redaction for command output that may contain
 * known secret values (env vars, tokens) even after upstream masking —
 * e.g. `ansible-playbook`'s raw stdout/stderr despite `no_log: true`, or a
 * CLI subprocess's stderr that happens to echo back an invalid API key.
 *
 * Unlike pattern-based masking (`logger.ts`'s `maskSecrets`), this only
 * catches secrets whose *exact* value is known ahead of time (e.g. the env
 * vars passed into a spawned subprocess) — it cannot catch secret-shaped
 * strings in general. Use both together: pattern-based masking for the
 * general case, this for known values that pattern matching would miss
 * (e.g. bare `sk-ant-...` keys with no `key=`/`key:` prefix).
 *
 * Empty-string values are skipped: replacing every occurrence of `''` would
 * corrupt the text (a global match on an empty string matches between every
 * character).
 */
export function redactSecretValues(text: string, secretValues: readonly string[]): string {
  let redacted = text
  for (const value of secretValues) {
    if (!value) continue
    redacted = redacted.split(value).join('***')
  }
  return redacted
}

/** Env var key names that look secret-like, for {@link collectSecretEnvValues}. */
const SECRET_ENV_KEY_PATTERN = /token|key|secret|password|credential/i

/**
 * Collect values of env vars whose key name looks secret-like (token/key/
 * secret/password/credential — case-insensitive substring match). Intended
 * as input to {@link redactSecretValues} for redacting subprocess output
 * (e.g. stderr) that may echo back one of these values verbatim in a shape
 * pattern-based masking (`logger.ts`'s `maskSecrets`) wouldn't catch — e.g.
 * a bare `sk-ant-...` key with no `key=`/`key:` prefix in an error message.
 */
export function collectSecretEnvValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key]) => SECRET_ENV_KEY_PATTERN.test(key))
    .map(([, value]) => value)
}
