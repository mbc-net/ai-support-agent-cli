/**
 * Browser URL security validation.
 */

import { BLOCKED_PROTOCOLS } from './browser-types'

/**
 * Validate a URL for browser navigation.
 * Blocks dangerous protocols (file://, javascript://, data://).
 * In Phase 3, URL whitelist from project settings will be enforced here.
 */
export function validateUrl(url: string): { valid: boolean; reason?: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { valid: false, reason: `Invalid URL: ${url}` }
  }

  const protocol = parsed.protocol.toLowerCase()
  if (BLOCKED_PROTOCOLS.includes(protocol)) {
    return { valid: false, reason: `Blocked protocol: ${protocol} — only http: and https: are allowed` }
  }

  return { valid: true }
}
