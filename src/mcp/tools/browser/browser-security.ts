/**
 * Browser URL security validation.
 */

import { BLOCKED_PROTOCOLS } from './browser-types'

/**
 * IPv4 CIDR ranges that must not be accessed by the browser tool (SSRF prevention).
 * Covers loopback, link-local, RFC1918 private, and cloud metadata endpoints.
 */
const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,           // 127.0.0.0/8 loopback
  /^10\.\d+\.\d+\.\d+$/,            // 10.0.0.0/8 private
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/, // 172.16.0.0/12 private
  /^192\.168\.\d+\.\d+$/,           // 192.168.0.0/16 private
  /^169\.254\.\d+\.\d+$/,           // 169.254.0.0/16 link-local (AWS metadata)
  /^100\.64\.\d+\.\d+$/,            // 100.64.0.0/10 shared address space
  /^::1$/,                           // IPv6 loopback
  /^fc[\da-f]{2}:/i,                 // IPv6 unique local fc00::/7
  /^fd[\da-f]{2}:/i,                 // IPv6 unique local fd00::/7
  /^fe80:/i,                         // IPv6 link-local
]

/**
 * Returns true if the hostname resolves to a private/internal network range.
 * Note: this is a static syntactic check (no DNS lookup).
 */
function isPrivateHost(hostname: string): boolean {
  // Strip IPv6 brackets
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname
  return PRIVATE_IP_PATTERNS.some((re) => re.test(host))
}

/**
 * Validate a URL for browser navigation.
 * Blocks dangerous protocols (file://, javascript://, data://) and
 * private/internal IP addresses to prevent SSRF.
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

  if (isPrivateHost(parsed.hostname)) {
    return { valid: false, reason: `Blocked host: access to internal/private addresses is not allowed` }
  }

  return { valid: true }
}
