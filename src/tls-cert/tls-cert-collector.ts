import { connect as tlsConnect, type TLSSocket } from 'node:tls'

import { getErrorMessage } from '../utils'

/** A host/port pair to inspect. */
export interface TlsCertTarget {
  domain: string
  port: number
}

/**
 * What a single inspection observed.
 *
 * Contract with the api side: **an observation is only usable for expiry
 * alerting when `notAfter` is present.** `reachable: true` without `notAfter`
 * means the handshake completed but nothing datable came back, which the
 * server must treat the same way it treats an unreachable target rather than
 * silently skipping it.
 */
export interface TlsCertObservation {
  domain: string
  port: number
  reachable: boolean
  /** ISO-8601. Absent when the certificate could not be read or dated. */
  notAfter?: string
  /** ISO-8601. Absent for the same reasons as `notAfter`. */
  notBefore?: string
  issuer?: string
  subject?: string
  /** Present whenever something went wrong, including on reachable targets. */
  error?: string
}

/** The subset of `tls.connect` this module depends on (injectable for tests). */
export type TlsConnectFn = (options: {
  host: string
  port: number
  servername: string
  rejectUnauthorized: boolean
}) => TLSSocket

export interface TlsCertCollectOptions {
  connect?: TlsConnectFn
  timeoutMs?: number
  concurrency?: number
}

export const DEFAULT_TLS_CHECK_TIMEOUT_MS = 10_000

/**
 * How many handshakes run at once. Kept small: a project can have many
 * monitored domains and this runs on an agent that is also doing real work.
 */
export const DEFAULT_TLS_CHECK_CONCURRENCY = 5

/** `Date` fields on a peer certificate are RFC 822-ish strings. */
function toIsoDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

/**
 * `issuer` / `subject` come back as objects of DN parts. Prefer the
 * organisation (issuer) or common name, and fall back to the raw value when
 * the shape is not what we expect rather than dropping it.
 */
function describeName(value: unknown, keys: string[]): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of keys) {
      const part = record[key]
      if (typeof part === 'string' && part.length > 0) return part
    }
  }
  return undefined
}

/**
 * Open a TLS connection to one target and report what its certificate says.
 *
 * `rejectUnauthorized: false` is deliberate. The job here is to *read* the
 * certificate, not to trust it: verifying would abort the handshake for
 * precisely the certificates this feature exists to report on (already
 * expired, self-signed, issued by an internal CA). Nothing is sent over the
 * connection and it is closed as soon as the certificate has been read.
 */
export function inspectTlsCertificate(
  target: TlsCertTarget,
  options: TlsCertCollectOptions = {},
): Promise<TlsCertObservation> {
  const connect = options.connect ?? (tlsConnect as unknown as TlsConnectFn)
  const timeoutMs = options.timeoutMs ?? DEFAULT_TLS_CHECK_TIMEOUT_MS

  return new Promise<TlsCertObservation>((resolve) => {
    let settled = false
    let socket: TLSSocket | undefined

    // The socket can emit more than one of these (an error after close, a
    // close after secureConnect). Only the first outcome counts; the rest are
    // noise from teardown.
    const settle = (observation: TlsCertObservation): void => {
      if (settled) return
      settled = true
      try {
        socket?.destroy()
      } catch {
        // Destroying an already-broken socket must not mask the observation.
      }
      resolve(observation)
    }

    const unreachable = (error: string): void =>
      settle({ ...target, reachable: false, error })

    try {
      socket = connect({
        host: target.domain,
        port: target.port,
        // SNI. Without it a shared-IP host answers with the wrong certificate
        // and the monitor would watch an expiry that belongs to someone else.
        servername: target.domain,
        rejectUnauthorized: false,
      })
    } catch (error) {
      // Synchronous failures (bad options, immediate DNS refusal).
      unreachable(getErrorMessage(error))
      return
    }

    socket.setTimeout(timeoutMs)

    socket.once('secureConnect', () => {
      const certificate = (socket?.getPeerCertificate() ??
        {}) as unknown as Record<string, unknown>
      const notAfter = toIsoDate(certificate.valid_to)
      const notBefore = toIsoDate(certificate.valid_from)
      const issuer = describeName(certificate.issuer, ['O', 'CN'])
      const subject = describeName(certificate.subject, ['CN', 'O'])

      if (!notAfter) {
        // Handshake succeeded but there is nothing to alert on. Say so
        // explicitly instead of returning a target that would silently never
        // produce an expiry warning.
        settle({
          ...target,
          reachable: true,
          ...(notBefore ? { notBefore } : {}),
          ...(issuer ? { issuer } : {}),
          ...(subject ? { subject } : {}),
          error:
            'TLS handshake succeeded but the peer certificate had no readable expiry date',
        })
        return
      }

      settle({
        ...target,
        reachable: true,
        ...(notBefore ? { notBefore } : {}),
        notAfter,
        ...(issuer ? { issuer } : {}),
        ...(subject ? { subject } : {}),
      })
    })

    socket.once('timeout', () => {
      unreachable(`TLS handshake timed out after ${timeoutMs}ms`)
    })

    socket.once('error', (error: unknown) => {
      unreachable(getErrorMessage(error))
    })

    socket.once('close', () => {
      // Only meaningful before an outcome: the peer hung up mid-handshake.
      unreachable('Connection closed before the TLS handshake completed')
    })
  })
}

/**
 * Inspect every target, bounded by `concurrency`.
 *
 * One target failing never stops the others: each result carries its own
 * outcome so the server can tell "expiring soon" apart from "unreachable".
 * Results come back in the same order as `targets`.
 */
export async function collectTlsCertificates(
  targets: readonly TlsCertTarget[],
  options: TlsCertCollectOptions = {},
): Promise<TlsCertObservation[]> {
  if (targets.length === 0) return []

  const limit = Math.max(1, options.concurrency ?? DEFAULT_TLS_CHECK_CONCURRENCY)
  const results = new Array<TlsCertObservation>(targets.length)
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= targets.length) return
      results[index] = await inspectTlsCertificate(targets[index], options)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, targets.length) }, () => worker()),
  )
  return results
}
