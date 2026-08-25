import type { TlsCertTarget } from '../tls-cert/tls-cert-collector'

/** Port used when a target does not name one. */
export const DEFAULT_TLS_CHECK_PORT = 443

export interface TlsCertCheckRequest {
  targets: TlsCertTarget[]
  timeoutMs?: number
  concurrency?: number
}

/**
 * Validate a `tls_cert_check` payload into a concrete request.
 *
 * The server builds this payload from monitoring entries it has already
 * validated, so anything malformed here is a bug on the dispatch side. The
 * whole command is rejected rather than dropping the bad rows: a partial
 * result reads as "these domains are fine" to whoever looks at it, which is
 * the failure mode this feature exists to prevent.
 */
export function buildTlsCertCheckRequest(
  payload: unknown,
): TlsCertCheckRequest | { error: string } {
  if (!payload || typeof payload !== 'object') {
    return { error: 'tls_cert_check requires a payload object' }
  }
  const { targets, timeoutSeconds, concurrency } = payload as Record<
    string,
    unknown
  >

  if (!Array.isArray(targets) || targets.length === 0) {
    return { error: 'tls_cert_check requires a non-empty targets array' }
  }

  const resolved: TlsCertTarget[] = []
  for (const [index, entry] of targets.entries()) {
    if (!entry || typeof entry !== 'object') {
      return { error: `tls_cert_check target #${index} is not an object` }
    }
    const { domain, port } = entry as Record<string, unknown>
    if (typeof domain !== 'string' || domain.trim().length === 0) {
      return { error: `tls_cert_check target #${index} has no domain` }
    }
    if (port !== undefined && !isValidPort(port)) {
      return {
        error: `tls_cert_check target #${index} (${domain}) has an invalid port: ${String(port)}`,
      }
    }
    resolved.push({
      domain: domain.trim(),
      port: port === undefined ? DEFAULT_TLS_CHECK_PORT : (port as number),
    })
  }

  const request: TlsCertCheckRequest = { targets: resolved }

  if (timeoutSeconds !== undefined) {
    if (
      typeof timeoutSeconds !== 'number' ||
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds <= 0
    ) {
      return {
        error: `tls_cert_check timeoutSeconds must be a positive number: ${String(timeoutSeconds)}`,
      }
    }
    request.timeoutMs = Math.round(timeoutSeconds * 1000)
  }

  if (concurrency !== undefined) {
    if (!Number.isInteger(concurrency) || (concurrency as number) < 1) {
      return {
        error: `tls_cert_check concurrency must be a positive integer: ${String(concurrency)}`,
      }
    }
    request.concurrency = concurrency as number
  }

  return request
}

function isValidPort(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535
}
