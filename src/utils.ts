export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function parseString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  return null
}

export function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && !isNaN(value)) return value
  return null
}

export function validateApiUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return `Invalid protocol: ${parsed.protocol}. Only http: and https: are allowed`
    }
    return null
  } catch {
    return `Invalid URL: ${url}`
  }
}
