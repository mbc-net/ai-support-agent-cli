type SecretKeyValueMatch = [
  match: string,
  prefix: string,
  value: string,
]

export const SECRET_KEY_VALUE_PATTERN =
  /((?:password|secret|token|api_key|apikey|access_key|secret_key|session_token|authorization)\s*[:=]\s*)((?:\\["'])(?:[^\\]|\\(?!["']))*(?:\\["'])|"[^"]*"|'[^']*'|[^\s"',}\\]+)/gi

export function maskSecretKeyValue(
  _match: string,
  prefix: string,
  value: string,
): string {
  const escapedQuote = value.slice(0, 2)
  if ((escapedQuote === '\\"' || escapedQuote === "\\'") && value.endsWith(escapedQuote)) {
    return `${prefix}${escapedQuote}****${escapedQuote}`
  }

  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
    return `${prefix}${quote}****${quote}`
  }

  return `${prefix}****`
}

export function maskSecretKeyValues(input: string): string {
  SECRET_KEY_VALUE_PATTERN.lastIndex = 0
  return input.replace(SECRET_KEY_VALUE_PATTERN, (...args: SecretKeyValueMatch) =>
    maskSecretKeyValue(args[0], args[1], args[2]),
  )
}
