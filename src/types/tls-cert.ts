/**
 * Payload of the `tls_cert_check` command.
 *
 * The server sends the domains it is monitoring for certificate expiry and the
 * agent reports what each one's certificate says. The agent is the only party
 * that can reach hosts on a closed network, which is why the handshake happens
 * here rather than on the api side.
 *
 * Targets are built server-side from already-validated monitoring entries, so
 * a malformed target means a bug rather than bad user input: the handler
 * rejects the whole command instead of quietly dropping rows, which would look
 * like "the domain is fine" to whoever reads the result.
 */
export interface TlsCertCheckTarget {
  domain: string
  /** Defaults to 443 when omitted. */
  port?: number
}

export interface TlsCertCheckPayload {
  targets: TlsCertCheckTarget[]
  /** Per-target handshake timeout. Defaults to the collector's own default. */
  timeoutSeconds?: number
  /** How many handshakes may run at once. Defaults to the collector's default. */
  concurrency?: number
}
