/**
 * `rdp_open.tunnel` — the route the API resolved for an RDP session that cannot
 * be reached directly from guacd (api ⇔ agent contract 1).
 *
 * The API is the single decision point for *which* route a host uses; the
 * agent still checks the **shape** of what it was handed before acting on it.
 * A malformed instruction would otherwise make the agent carry credentials to
 * a destination nobody configured.
 *
 * :::danger
 * `via` carries secrets (SSH key / password, AWS secret key and session token,
 * Tailscale auth key). Rejection messages name **fields only, never values** —
 * they travel to the API and on to the browser verbatim.
 * :::
 */

/** Route kinds. Mirrors the API's `RDP_TUNNEL_KINDS` (single source of truth there). */
export const RDP_TUNNEL_KINDS = ['ssh', 'ssm', 'tailscale'] as const

export type RdpTunnelKind = (typeof RDP_TUNNEL_KINDS)[number]

/** The RDP destination as seen from the far end of the tunnel. */
export interface RdpTunnelTarget {
  host: string
  port: number
}

export interface RdpSshTunnel {
  kind: 'ssh'
  target: RdpTunnelTarget
  via: {
    hostId: string
    hostname: string
    port: number
    username: string
    authType: 'privateKey' | 'password'
    /** Private key or password. Never logged. */
    credential: string
  }
}

export interface RdpSsmTunnel {
  kind: 'ssm'
  target: RdpTunnelTarget
  via: {
    hostId: string
    instanceId: string
    region: string
    awsCredentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  }
}

export interface RdpTailscaleTunnel {
  kind: 'tailscale'
  target: RdpTunnelTarget
  via: {
    hostId: string
    /** Tailscale auth key. Never logged, never put on a command line. */
    authKey: string
  }
}

export type RdpTunnel = RdpSshTunnel | RdpSsmTunnel | RdpTailscaleTunnel

/** The instruction cannot be acted on. The message names fields, never values. */
export class RdpTunnelRejectedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RdpTunnelRejectedError'
  }
}

/**
 * Host names and addresses only. Anything else is refused because the value
 * reaches argument strings: SSM receives it inside
 * `--parameters host=<h>,portNumber=<p>,...`, where a comma would let the
 * instruction replace the destination port.
 */
const HOST_PATTERN = /^[A-Za-z0-9._:[\]-]+$/
const HOST_MAX_LENGTH = 253
const INSTANCE_ID_PATTERN = /^m?i-[0-9a-f]+$/
const REGION_PATTERN = /^[a-z0-9-]+$/
const SSH_AUTH_TYPES = ['privateKey', 'password'] as const

/** Keys each kind's `via` may carry. A key outside the set means the shapes disagree. */
const VIA_KEYS: Record<RdpTunnelKind, readonly string[]> = {
  ssh: ['hostId', 'hostname', 'port', 'username', 'authType', 'credential'],
  ssm: ['hostId', 'instanceId', 'region', 'awsCredentials'],
  tailscale: ['hostId', 'authKey'],
}
const AWS_CREDENTIAL_KEYS = ['accessKeyId', 'secretAccessKey', 'sessionToken']

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reject(detail: string): never {
  throw new RdpTunnelRejectedError(`invalid RDP tunnel instruction: ${detail}`)
}

function requireString(obj: Json, key: string, field: string): string {
  const value = obj[key]
  if (typeof value !== 'string' || value.length === 0) {
    reject(`${field} must be a non-empty string`)
  }
  return value
}

function requirePort(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    reject(`${field} must be an integer between 1 and 65535`)
  }
  return value
}

function requireHost(obj: Json, key: string, field: string): string {
  const value = requireString(obj, key, field)
  if (value.length > HOST_MAX_LENGTH || !HOST_PATTERN.test(value)) {
    reject(`${field} is not a valid host name or address`)
  }
  return value
}

function requireMatch(obj: Json, key: string, field: string, pattern: RegExp): string {
  const value = requireString(obj, key, field)
  if (!pattern.test(value)) reject(`${field} has an invalid format`)
  return value
}

function requireOnlyKeys(obj: Json, allowed: readonly string[], field: string): void {
  const unexpected = Object.keys(obj).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    // Key names are part of the contract, not secret — naming them helps tell
    // an API/agent version skew apart from a real fault.
    reject(`${field} has fields that do not belong to this kind: ${unexpected.join(', ')}`)
  }
}

function parseTarget(raw: unknown): RdpTunnelTarget {
  if (!isObject(raw)) reject('target must be an object')
  return {
    host: requireHost(raw, 'host', 'target.host'),
    port: requirePort(raw.port, 'target.port'),
  }
}

function parseSshVia(via: Json): RdpSshTunnel['via'] {
  const hostId = requireString(via, 'hostId', 'via.hostId')
  const hostname = requireHost(via, 'hostname', 'via.hostname')
  const port = requirePort(via.port, 'via.port')
  const username = requireString(via, 'username', 'via.username')
  const authType = via.authType
  if (!SSH_AUTH_TYPES.includes(authType as (typeof SSH_AUTH_TYPES)[number])) {
    reject(`via.authType must be one of ${SSH_AUTH_TYPES.join(', ')}`)
  }
  const credential = requireString(via, 'credential', 'via.credential')
  return {
    hostId,
    hostname,
    port,
    username,
    authType: authType as RdpSshTunnel['via']['authType'],
    credential,
  }
}

function parseSsmVia(via: Json): RdpSsmTunnel['via'] {
  const hostId = requireString(via, 'hostId', 'via.hostId')
  const instanceId = requireMatch(via, 'instanceId', 'via.instanceId', INSTANCE_ID_PATTERN)
  const region = requireMatch(via, 'region', 'via.region', REGION_PATTERN)
  const raw = via.awsCredentials
  if (!isObject(raw)) reject('via.awsCredentials must be an object')
  requireOnlyKeys(raw, AWS_CREDENTIAL_KEYS, 'via.awsCredentials')
  const accessKeyId = requireString(raw, 'accessKeyId', 'via.awsCredentials.accessKeyId')
  const secretAccessKey = requireString(
    raw,
    'secretAccessKey',
    'via.awsCredentials.secretAccessKey',
  )
  const awsCredentials: RdpSsmTunnel['via']['awsCredentials'] = { accessKeyId, secretAccessKey }
  if (raw.sessionToken !== undefined) {
    awsCredentials.sessionToken = requireString(
      raw,
      'sessionToken',
      'via.awsCredentials.sessionToken',
    )
  }
  return { hostId, instanceId, region, awsCredentials }
}

function parseTailscaleVia(via: Json): RdpTailscaleTunnel['via'] {
  return {
    hostId: requireString(via, 'hostId', 'via.hostId'),
    authKey: requireString(via, 'authKey', 'via.authKey'),
  }
}

/**
 * Validate `rdp_open.tunnel` and return a fresh copy holding only the contract
 * fields.
 *
 * @throws {RdpTunnelRejectedError} when kind and `via` disagree, or a required
 *   value is missing or malformed
 */
export function parseRdpTunnel(raw: unknown): RdpTunnel {
  if (!isObject(raw)) reject('tunnel must be an object')
  const kind = raw.kind
  if (!RDP_TUNNEL_KINDS.includes(kind as RdpTunnelKind)) {
    reject(`kind must be one of ${RDP_TUNNEL_KINDS.join(', ')}`)
  }
  const target = parseTarget(raw.target)
  const via = raw.via
  if (!isObject(via)) reject('via must be an object')
  requireOnlyKeys(via, VIA_KEYS[kind as RdpTunnelKind], 'via')

  switch (kind as RdpTunnelKind) {
    case 'ssh':
      return { kind: 'ssh', target, via: parseSshVia(via) }
    case 'ssm':
      return { kind: 'ssm', target, via: parseSsmVia(via) }
    case 'tailscale':
      return { kind: 'tailscale', target, via: parseTailscaleVia(via) }
  }
}

/** Every secret value in the instruction, for masking error messages. */
export function rdpTunnelSecrets(tunnel: RdpTunnel): string[] {
  switch (tunnel.kind) {
    case 'ssh':
      return [tunnel.via.credential]
    case 'ssm': {
      const { secretAccessKey, sessionToken } = tunnel.via.awsCredentials
      return sessionToken ? [secretAccessKey, sessionToken] : [secretAccessKey]
    }
    case 'tailscale':
      return [tunnel.via.authKey]
  }
}
