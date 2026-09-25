/**
 * RDP tunnel routes: reach an RDP host that guacd cannot reach directly, by
 * opening a tunnel (SSH / SSM / Tailscale) and a relay that guacd connects to
 * in place of the host.
 *
 * ```
 * guacd ──TCP──▶ relay (this process) ──dial()──▶ tunnel ──▶ RDP host
 * ```
 *
 * The route is decided by the API alone (`rdp_open.tunnel`, contract 1). This
 * module only carries it out, and **never falls back to a direct connection**:
 * if the tunnel cannot be opened the session fails.
 *
 * Lifecycle is per session: one tunnel and one relay. guacd (FreeRDP) may open
 * **several** TCP connections during a session — it reconnects to renegotiate
 * the security layer and on auto-reconnect — so the relay accepts connections
 * for as long as the session lives, and opens one tunnel stream per
 * connection. A connection ending ends only that pair. The registry closes the
 * handle when the session ends, and the handle reports when the tunnel itself
 * (SSH client, SSM subprocess, tailscaled) went away so the session ends too.
 *
 * :::danger
 * The relay is as unauthenticated as guacd: whoever connects to it is piped
 * straight into the customer network. Hence it listens only where guacd can
 * reach it, admits only guacd's address (127.0.0.1 on loopback, the resolved
 * `ais-guacd` address in the Docker form), dials only for a connection that
 * presents this session's token in its Connection Request
 * (`rdp-relay-gate.ts`), caps concurrent connections at
 * {@link RDP_TUNNEL_MAX_CONNECTIONS} and closes with the session.
 * :::
 */

import { spawn, type ChildProcess } from 'child_process'
import * as dgram from 'dgram'
import { promises as dns } from 'dns'
import * as net from 'net'
import type { Duplex } from 'stream'

import { LOCALHOST_ADDRESS } from '../constants'
import { logger } from '../logger'
import { connectSshClient } from '../mcp/tools/db-tunnel'
import { killSubprocess, openSsmTunnel as defaultOpenSsmTunnel } from '../mcp/tools/db-ssm-tunnel'
import type { SsmTunnel, SsmTunnelParams } from '../mcp/tools/db-ssm-tunnel'
import { getErrorMessage } from '../utils'
import { buildAwsCredentialEnv } from '../utils/aws-credential-env'
import { trackChildProcess } from '../utils/child-process-reaper'
import { createClosedSignal } from '../utils/closed-signal'
import { canonicalIpAddress } from '../utils/ip-address'
import { openStdioStream } from '../utils/stdio-stream'
import { withTimeout } from '../utils/wait-until'
import { checkDirectRdpTarget } from './rdp-direct-target'
import { inspectConnectionRequest, readFirstTpkt, RELAY_GATE_TIMEOUT_MS } from './rdp-relay-gate'
import { registerRelayAddress } from './rdp-relay-registry'
import { createSsmBannerFilter } from './ssm-session-banner'
import {
  rdpTunnelSecrets,
  type RdpSshTunnel,
  type RdpSsmTunnel,
  type RdpTailscaleTunnel,
  type RdpTunnel,
  type RdpTunnelKind,
} from './rdp-tunnel-message'
import {
  detectRdpTunnelKinds,
  resolveRdpTunnelListenMode,
  type RdpTunnelListenMode,
} from './rdp-tunnel-support'
import { openTailscaleRdpDialer } from './rdp-tunnel-tailscale'

export { listActiveRelayAddresses } from './rdp-relay-registry'

/** Budget for opening one stream through a tunnel (SSH channel, SSM port connect). */
export const RDP_TUNNEL_DIAL_TIMEOUT_MS = 30_000
/** Budget for {@link openRdpTunnel} as a whole: tunnel, first dial and relay. */
export const RDP_TUNNEL_OPEN_TIMEOUT_MS = 90_000

/** An open tunnel that can produce a stream to the RDP target. */
export interface RdpTunnelDialer {
  /** Open one stream to the target through the tunnel. */
  dial(): Promise<Duplex>
  /** Tear the tunnel down. Idempotent. */
  close(): Promise<void>
  /**
   * The tunnel itself went away (connection dropped, process exited).
   *
   * Must not depend on registration order: a listener registered after the
   * tunnel already went away is still called (asynchronously) with the reason.
   */
  onClosed(listener: (reason: string) => void): void
}

/** What the session registry holds for a tunneled session. */
export interface RdpTunnelHandle {
  /** Address to hand guacd as `hostname`. */
  host: string
  /** Port to hand guacd as `port`. */
  port: number
  /** Close relay and tunnel. Idempotent. */
  close(): Promise<void>
  /** Fires once when the relay or the tunnel closed, for whatever reason. */
  onClosed(listener: (reason: string) => void): void
}

// ---------------------------------------------------------------------------
// Dialers
// ---------------------------------------------------------------------------

/**
 * SSH route: authenticate to `via` and open `direct-tcpip` channels to the
 * target (`localhost:<rdp port>` for the host's own OpenSSH server, the RDP
 * host's address when `via` is a jump host).
 */
export async function openSshRdpDialer(
  tunnel: RdpSshTunnel,
  options: { dialTimeoutMs?: number } = {},
): Promise<RdpTunnelDialer> {
  const { via, target } = tunnel
  const dialTimeoutMs = options.dialTimeoutMs ?? RDP_TUNNEL_DIAL_TIMEOUT_MS
  const client = await connectSshClient(
    {
      hostId: via.hostId,
      hostname: via.hostname,
      port: via.port,
      username: via.username,
      authType: via.authType,
      privateKey: via.credential,
    },
    '[rdp-tunnel]',
  )

  // Tracked from the moment the client is connected, so a drop that happens
  // before anyone registers (e.g. during the first dial) is not lost.
  const gone = createClosedSignal()
  client.once('close', () => gone.close(`SSH connection to ${via.hostId} closed`))

  return {
    dial: () =>
      withTimeout(
        new Promise<Duplex>((resolve, reject) => {
          client.forwardOut(LOCALHOST_ADDRESS, 0, target.host, target.port, (err, stream) => {
            if (err) reject(err)
            else resolve(stream)
          })
        }),
        dialTimeoutMs,
        `SSH forward to ${target.host}:${target.port} timed out after ${dialTimeoutMs}ms`,
        // A channel that opens after the deadline has no taker.
        (late) => late.destroy(),
      ),
    close: async () => {
      client.end()
    },
    onClosed: (listener) => gone.onClosed(listener),
  }
}

export interface SsmDialerDeps {
  openSsmTunnel?: (params: SsmTunnelParams) => Promise<SsmTunnel>
  /** Start `aws <args>` with piped stdio (self-host, stdio mode). */
  spawnSsmStdio?: (args: string[], env: NodeJS.ProcessEnv) => ChildProcess
  dialTimeoutMs?: number
  /** See `StdioStreamOptions.settleMs`. */
  stdioSettleMs?: number
}

/** `aws` with piped stdio, tracked so it cannot outlive the agent. */
function spawnAwsStdio(args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return trackChildProcess(spawn('aws', args, { stdio: ['pipe', 'pipe', 'pipe'], env }))
}

/**
 * SSM route.
 *
 * - **Via the host itself** (`target.host === 'localhost'`): each dial starts
 *   `aws ssm start-session --document-name AWS-StartSSHSession --parameters
 *   portNumber=<rdp port>` and uses its stdin/stdout — the same way
 *   `ssh -o ProxyCommand=…` uses that document. The document has no
 *   `"type": "LocalPortForwarding"` property, so session-manager-plugin runs
 *   its standard-stream mode (`StandardStreamForwarding`, stdin/stdout) and
 *   the SSM agent connects to `localhost:<portNumber>` on the instance.
 *   The plugin also writes a status line to that stdout before the data;
 *   `ssm-session-banner.ts` removes exactly that line and refuses anything
 *   else it cannot identify.
 *   **Nothing listens on this host.** Needs `ssm:StartSession` on the
 *   `AWS-StartSSHSession` document.
 * - **Via a jump instance** (any other `target.host`):
 *   `AWS-StartPortForwardingSessionToRemoteHost` has no stdio mode, so the
 *   plugin listens on a random `127.0.0.1` port (`openSsmTunnel`) and each
 *   dial connects to it.
 *
 *   :::warning 残るリスク
 *   While the session lives, any local process can connect to that port. What
 *   it reaches is fixed by the session: that one RDP host and port, nothing
 *   else — and the RDP host still demands its own credentials. In the K8s /
 *   ECS forms the port is inside the Pod / task's network namespace.
 *   :::
 *
 * For the jump form the plugin subprocess ending is the tunnel ending, and is
 * reported through `onClosed`. The stdio form has no long-lived process: each
 * connection's process ends with that connection.
 */
export async function openSsmRdpDialer(
  tunnel: RdpSsmTunnel,
  deps: SsmDialerDeps = {},
): Promise<RdpTunnelDialer> {
  const dialTimeoutMs = deps.dialTimeoutMs ?? RDP_TUNNEL_DIAL_TIMEOUT_MS
  const { via, target } = tunnel

  if (target.host === 'localhost') {
    const spawnStdio = deps.spawnSsmStdio ?? spawnAwsStdio
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...buildAwsCredentialEnv(via.awsCredentials, via.region),
    }
    const children = new Set<ChildProcess>()
    return {
      dial: () => {
        const child = spawnStdio(
          [
            'ssm',
            'start-session',
            '--target',
            via.instanceId,
            '--document-name',
            'AWS-StartSSHSession',
            '--parameters',
            `portNumber=${target.port}`,
            '--region',
            via.region,
          ],
          env,
        )
        children.add(child)
        child.once('exit', () => children.delete(child))
        return openStdioStream(child, {
          label: `SSM session to ${via.instanceId}:${target.port}`,
          timeoutMs: dialTimeoutMs,
          settleMs: deps.stdioSettleMs,
          // The plugin prints a status line before the data (ssm-session-banner.ts).
          transformStdout: createSsmBannerFilter,
        })
      },
      close: async () => {
        await Promise.all([...children].map((child) => killSubprocess(child)))
      },
      onClosed: () => {
        // No long-lived tunnel process in stdio mode (see above).
      },
    }
  }

  const openSsm = deps.openSsmTunnel ?? defaultOpenSsmTunnel
  const local = await openSsm({
    instanceId: via.instanceId,
    region: via.region,
    awsCredentials: via.awsCredentials,
    target,
  })

  return {
    dial: () =>
      withTimeout(
        new Promise<Duplex>((resolve, reject) => {
          const socket = net.connect(local.port, local.host)
          socket.once('connect', () => {
            socket.removeListener('error', reject)
            resolve(socket)
          })
          socket.once('error', reject)
        }),
        dialTimeoutMs,
        `SSM port forward connect timed out after ${dialTimeoutMs}ms`,
        (late) => late.destroy(),
      ),
    close: () => local.close(),
    onClosed: (listener) => local.onClosed(listener),
  }
}

export interface RdpTunnelDialerOpeners {
  ssh?: (tunnel: RdpSshTunnel) => Promise<RdpTunnelDialer>
  ssm?: (tunnel: RdpSsmTunnel) => Promise<RdpTunnelDialer>
  tailscale?: (tunnel: RdpTailscaleTunnel, ctx: { sessionId: string }) => Promise<RdpTunnelDialer>
}

/** Open the dialer for the tunnel's kind. */
export function openRdpTunnelDialer(
  tunnel: RdpTunnel,
  ctx: { sessionId: string },
  openers: RdpTunnelDialerOpeners = {},
): Promise<RdpTunnelDialer> {
  switch (tunnel.kind) {
    case 'ssh':
      return (openers.ssh ?? openSshRdpDialer)(tunnel)
    case 'ssm':
      return (openers.ssm ?? ((t: RdpSsmTunnel) => openSsmRdpDialer(t)))(tunnel)
    case 'tailscale':
      return (openers.tailscale ?? ((t, c) => openTailscaleRdpDialer(t, c)))(tunnel, ctx)
  }
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

/** Where the relay listens and whom it admits. */
export interface RdpRelayBinding {
  /** Address the relay binds to. */
  bindHost: string
  /** Address handed to guacd as `hostname`. */
  advertiseHost: string
  /** When set, connections from any other address are dropped. */
  allowedPeer?: string
}

export interface RelayBindingDeps {
  lookup?: (host: string) => Promise<{ address: string; family: number }>
  /** The local address this host uses to reach `peer`. */
  localAddressFor?: (peer: string) => Promise<string>
}

/**
 * The local address the kernel would use to reach `peer`.
 *
 * A connected UDP socket selects the route without sending anything, so no
 * packet reaches guacd.
 */
function routeLocalAddress(peer: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    socket.once('error', (err) => {
      socket.close()
      reject(err)
    })
    socket.connect(9, peer, () => {
      const { address } = socket.address()
      socket.close()
      resolve(address)
    })
  })
}

/**
 * Decide where the relay listens.
 *
 * - `loopback`: guacd shares the network namespace (K8s Pod / ECS awsvpc task).
 * - `docker-network`: listen on the address this container uses to reach guacd
 *   on the `ais-rdp` network, and admit only guacd's address.
 */
export async function resolveRdpRelayBinding(
  mode: RdpTunnelListenMode,
  guacdHost: string,
  deps: RelayBindingDeps = {},
): Promise<RdpRelayBinding> {
  if (mode === 'loopback') {
    // Only the loopback peer: guacd shares this network namespace.
    return {
      bindHost: LOCALHOST_ADDRESS,
      advertiseHost: LOCALHOST_ADDRESS,
      allowedPeer: LOCALHOST_ADDRESS,
    }
  }
  const lookup = deps.lookup ?? ((host: string) => dns.lookup(host, { family: 4 }))
  const localAddressFor = deps.localAddressFor ?? routeLocalAddress
  let guacdAddress: string
  try {
    guacdAddress = (await lookup(guacdHost)).address
  } catch (error) {
    throw new Error(
      `RDP tunnel relay could not resolve guacd host ${guacdHost}: ${getErrorMessage(error)}`,
    )
  }
  const local = await localAddressFor(guacdAddress)
  // :::danger
  // A route that could not be selected comes back as the wildcard address
  // rather than as an error (observed with dgram on unroutable peers).
  // Binding to it would expose the relay on every interface.
  // :::
  if (!net.isIPv4(local) || local === '0.0.0.0') {
    throw new Error(
      `RDP tunnel relay could not determine the local address that reaches guacd (${guacdAddress})`,
    )
  }
  return { bindHost: local, advertiseHost: local, allowedPeer: guacdAddress }
}

/**
 * Canonical peer address for the `allowedPeer` comparison: an IPv4-mapped
 * IPv6 address in any spelling becomes its IPv4 address (shared with the
 * direct-target check, `utils/ip-address.ts`).
 */
export function normalizePeerAddress(address: string | undefined): string {
  return canonicalIpAddress(address)
}

/**
 * Most guacd connections one session's relay carries at once. guacd holds one
 * per RDP connection and may briefly overlap an old and a new one while
 * reconnecting; anything beyond this is not guacd behaving normally.
 */
export const RDP_TUNNEL_MAX_CONNECTIONS = 4

/**
 * Most connections waiting for their Connection Request (token check) at once.
 * Counted separately from {@link RDP_TUNNEL_MAX_CONNECTIONS}: idle connections
 * that never send anything must not use up the slots guacd needs. When full,
 * the **oldest** waiting connection is dropped, so a flood of idle
 * connections cannot lock out guacd's reconnect (which sends its request
 * within milliseconds).
 */
export const RDP_TUNNEL_MAX_PENDING_CONNECTIONS = 4

export interface RdpTunnelRelayOptions {
  /** Opens one stream to the RDP target through the tunnel, per connection. */
  dial: () => Promise<Duplex>
  /**
   * A stream already dialed (to surface tunnel errors before guacd is told
   * anything). Used for the first connection; destroyed if never used.
   */
  preDialed?: Duplex
  /** Cap on admitted (token-checked) connections. Defaults to {@link RDP_TUNNEL_MAX_CONNECTIONS}. */
  maxConnections?: number
  /** Cap on connections awaiting the token check. Defaults to {@link RDP_TUNNEL_MAX_PENDING_CONNECTIONS}. */
  maxPendingConnections?: number
  /** Called when a per-connection dial fails (the connection is dropped). */
  onDialError?: (error: unknown) => void
  /**
   * The session's relay token. A connection is dialed only if its X.224
   * Connection Request carries it as the routing token (see
   * `rdp-relay-gate.ts`); the token is stripped before forwarding.
   * **Secret.**
   */
  expectedToken: string
  /** Deadline for the Connection Request. Defaults to {@link RELAY_GATE_TIMEOUT_MS}. */
  gateTimeoutMs?: number
  /**
   * The API's own `load-balance-info`. When set, it replaces the token line as
   * the routing token forwarded to the RDP host (e.g. RD Connection Broker).
   * Server Redirection (the host redirecting the client elsewhere) is **not
   * supported** through a tunnel: the redirected connection would not come
   * back through this relay.
   */
  forwardRoutingToken?: string
}

export interface RdpTunnelRelay {
  host: string
  port: number
  readonly isClosed: boolean
  /** Admitted (token-checked) connections not yet closed, including those still dialing. */
  readonly activeConnections: number
  close(): Promise<void>
  /** Fires exactly once, on close. A listener added after closing is called right away. */
  onClosed(listener: (reason: string) => void): void
}

/**
 * Listen for guacd for the life of the session and pipe each accepted
 * connection to its own tunnel stream.
 *
 * Only `close()` (the session ending) closes the relay; a connection ending —
 * from either side — closes just that pair and the listener stays up for
 * guacd to reconnect. `preDialed` is destroyed on close and when listening
 * fails.
 */
export async function startRdpTunnelRelay(
  binding: RdpRelayBinding,
  options: RdpTunnelRelayOptions,
): Promise<RdpTunnelRelay> {
  const maxConnections = options.maxConnections ?? RDP_TUNNEL_MAX_CONNECTIONS
  const server = net.createServer()
  const maxPending = options.maxPendingConnections ?? RDP_TUNNEL_MAX_PENDING_CONNECTIONS
  /** Awaiting the token check, oldest first (Set keeps insertion order). */
  const pending = new Set<net.Socket>()
  /** Admitted. */
  const connections = new Set<net.Socket>()
  const streams = new Set<Duplex>()
  let preDialed: Duplex | undefined = options.preDialed
  const closed = createClosedSignal()
  let releaseAddress: (() => void) | null = null

  if (preDialed) {
    const held = preDialed
    held.on('error', () => undefined)
    // A pre-dialed stream that ends while waiting for guacd is no use: drop it
    // so the first connection dials afresh.
    held.once('close', () => {
      if (preDialed === held) preDialed = undefined
    })
  }

  const finish = (reason: string): void => {
    if (!closed.close(reason)) return
    server.close()
    releaseAddress?.()
    for (const socket of pending) socket.destroy()
    for (const socket of connections) socket.destroy()
    for (const stream of streams) stream.destroy()
    preDialed?.destroy()
    preDialed = undefined
  }

  /** The pre-dialed stream, if it is still usable; otherwise `undefined`. */
  const takePreDialed = (): Duplex | undefined => {
    const held = preDialed
    preDialed = undefined
    if (!held) return undefined
    if (held.destroyed || held.readableEnded) {
      held.destroy()
      return undefined
    }
    return held
  }

  const pair = async (socket: net.Socket, first: Buffer): Promise<void> => {
    let stream: Duplex
    const held = takePreDialed()
    if (held) {
      stream = held
    } else {
      try {
        stream = await options.dial()
      } catch (error) {
        options.onDialError?.(error)
        socket.destroy()
        return
      }
    }
    // The session ended, or guacd gave up, while the stream was being opened.
    if (closed.isClosed || socket.destroyed) {
      stream.destroy()
      return
    }
    streams.add(stream)
    const teardown = (): void => {
      socket.destroy()
      stream.destroy()
    }
    stream.on('error', teardown)
    stream.once('close', () => {
      streams.delete(stream)
      teardown()
    })
    socket.on('error', teardown)
    // The Connection Request, with the token removed, goes first.
    stream.write(first)
    socket.pipe(stream)
    stream.pipe(socket)
  }

  /**
   * Admit a connection only with this session's token; otherwise drop it
   * without dialing (a dial would reach the customer's RDP host).
   */
  const admit = async (socket: net.Socket): Promise<void> => {
    let first: Buffer
    try {
      const { packet, rest } = await readFirstTpkt(socket, { timeoutMs: options.gateTimeoutMs })
      const result = inspectConnectionRequest(
        packet,
        options.expectedToken,
        options.forwardRoutingToken,
      )
      if (!result.ok) throw new Error(result.reason)
      first = Buffer.concat([result.rewritten, rest])
    } catch (error) {
      logger.warn(
        `[rdp-tunnel] Refused a relay connection from ${normalizePeerAddress(socket.remoteAddress)}: ${getErrorMessage(error)}`,
      )
      socket.destroy()
      return
    }
    pending.delete(socket)
    if (closed.isClosed || socket.destroyed) {
      socket.destroy()
      return
    }
    // The cap applies to admitted connections only.
    if (connections.size >= maxConnections) {
      logger.warn(
        `[rdp-tunnel] Refused a relay connection: ${maxConnections} connections are already open`,
      )
      socket.destroy()
      return
    }
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
    await pair(socket, first)
  }

  server.on('connection', (socket) => {
    socket.on('error', () => undefined)
    if (closed.isClosed) {
      socket.destroy()
      return
    }
    const peer = normalizePeerAddress(socket.remoteAddress)
    if (binding.allowedPeer && peer !== binding.allowedPeer) {
      logger.warn(`[rdp-tunnel] Refused a relay connection from ${peer} (only guacd may connect)`)
      socket.destroy()
      return
    }
    // Waiting connections have their own cap; the oldest one yields.
    if (pending.size >= maxPending) {
      const oldest = pending.values().next().value as net.Socket
      pending.delete(oldest)
      oldest.destroy()
      logger.warn(
        `[rdp-tunnel] Dropped the oldest relay connection still waiting for its Connection Request (${maxPending} waiting)`,
      )
    }
    pending.add(socket)
    socket.once('close', () => pending.delete(socket))
    void admit(socket)
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', (err) => {
      preDialed?.destroy()
      reject(new Error(`RDP tunnel relay could not listen on ${binding.bindHost}: ${err.message}`))
    })
    server.listen(0, binding.bindHost, () => {
      resolve((server.address() as net.AddressInfo).port)
    })
  })
  server.on('error', (err) => finish(`relay error: ${err.message}`))
  // Published so a direct connection can never be pointed at this relay.
  releaseAddress = registerRelayAddress(binding.bindHost)

  return {
    host: binding.advertiseHost,
    port,
    get isClosed() {
      return closed.isClosed
    },
    get activeConnections() {
      return connections.size
    },
    close: async () => {
      finish('relay closed')
    },
    onClosed: (listener) => closed.onClosed(listener),
  }
}

// ---------------------------------------------------------------------------
// Session-level assembly
// ---------------------------------------------------------------------------

/** Replace every secret occurrence in `message` with `***`. */
function maskSecrets(message: string, secrets: string[]): string {
  return secrets.reduce(
    (masked, secret) => (secret ? masked.split(secret).join('***') : masked),
    message,
  )
}

export interface OpenRdpTunnelContext {
  sessionId: string
  /** The guacd host the relay must be reachable from. */
  guacdHost: string
  listenMode: RdpTunnelListenMode
  /** The session's relay token (see `rdp-relay-gate.ts`). **Secret.** */
  relayToken: string
  /** The API's `load-balance-info`, put back in place of the token. */
  forwardRoutingToken?: string
}

export interface OpenRdpTunnelDeps {
  openDialer?: (tunnel: RdpTunnel, ctx: { sessionId: string }) => Promise<RdpTunnelDialer>
  resolveBinding?: (mode: RdpTunnelListenMode, guacdHost: string) => Promise<RdpRelayBinding>
  /** Budget for the whole establishment. Defaults to {@link RDP_TUNNEL_OPEN_TIMEOUT_MS}. */
  openTimeoutMs?: number
}

/**
 * Open the tunnel, dial the target once, and start the relay guacd will use.
 *
 * The first dial happens before guacd is told anything, so a refused forward
 * or an unreachable host is reported as a tunnel failure rather than as an
 * opaque guacd error; that stream serves guacd's first connection, and each
 * later connection dials its own. Failure messages have every secret of the
 * instruction masked.
 *
 * The whole establishment has a deadline; a tunnel that comes up after it is
 * closed at once rather than left running with nobody to use it.
 *
 * The handle closes — and reports — when the tunnel itself goes away or the
 * session closes it; guacd connections coming and going do not close it.
 */
export async function openRdpTunnel(
  tunnel: RdpTunnel,
  ctx: OpenRdpTunnelContext,
  deps: OpenRdpTunnelDeps = {},
): Promise<RdpTunnelHandle> {
  const label = `RDP tunnel (${tunnel.kind} via ${tunnel.via.hostId})`
  const secrets = [...rdpTunnelSecrets(tunnel), ctx.relayToken]
  const openTimeoutMs = deps.openTimeoutMs ?? RDP_TUNNEL_OPEN_TIMEOUT_MS
  let timedOut = false
  try {
    return await withTimeout(
      establishRdpTunnel(tunnel, ctx, deps, label, secrets, () => timedOut),
      openTimeoutMs,
      `timed out after ${openTimeoutMs}ms`,
      (late) => {
        void late.close()
      },
    )
  } catch (error) {
    timedOut = true
    const message = getErrorMessage(error)
    throw new Error(
      message.startsWith(`${label} failed:`)
        ? message
        : maskSecrets(`${label} failed: ${message}`, secrets),
    )
  }
}

async function establishRdpTunnel(
  tunnel: RdpTunnel,
  ctx: OpenRdpTunnelContext,
  deps: OpenRdpTunnelDeps,
  label: string,
  secrets: string[],
  abandoned: () => boolean,
): Promise<RdpTunnelHandle> {
  const openDialer = deps.openDialer ?? openRdpTunnelDialer
  const resolveBinding = deps.resolveBinding ?? resolveRdpRelayBinding

  // Decide where to listen first: no point in opening a tunnel guacd cannot use.
  const binding = await resolveBinding(ctx.listenMode, ctx.guacdHost)

  let dialer: RdpTunnelDialer
  try {
    dialer = await openDialer(tunnel, { sessionId: ctx.sessionId })
  } catch (error) {
    throw new Error(maskSecrets(`${label} failed: ${getErrorMessage(error)}`, secrets))
  }

  // Registered before anything else can happen: a tunnel that drops during the
  // first dial or while the relay starts must not be missed, or the session
  // would be left half-open with its relay port still listening.
  const gone = createClosedSignal()
  dialer.onClosed((reason) => gone.close(reason))

  let relay: RdpTunnelRelay
  try {
    const preDialed = await dialer.dial()
    relay = await startRdpTunnelRelay(binding, {
      dial: () => dialer.dial(),
      preDialed,
      expectedToken: ctx.relayToken,
      forwardRoutingToken: ctx.forwardRoutingToken,
      onDialError: (error) => {
        logger.warn(
          `[rdp-tunnel] ${label} dial failed for session ${ctx.sessionId}: ${maskSecrets(getErrorMessage(error), secrets)}`,
        )
      },
    })
  } catch (error) {
    await dialer.close().catch(() => undefined)
    throw new Error(maskSecrets(`${label} failed: ${getErrorMessage(error)}`, secrets))
  }

  if (gone.isClosed || abandoned()) {
    await relay.close()
    await dialer.close().catch(() => undefined)
    throw new Error(
      maskSecrets(
        `${label} failed: tunnel closed before it was ready: ${gone.reason ?? 'abandoned'}`,
        secrets,
      ),
    )
  }

  const closed = createClosedSignal()
  let teardownPromise: Promise<void> | null = null
  const teardown = (): Promise<void> => {
    teardownPromise ??= (async () => {
      await relay.close()
      await dialer.close().catch((error: unknown) => {
        logger.warn(
          `[rdp-tunnel] ${label} close failed: ${maskSecrets(getErrorMessage(error), secrets)}`,
        )
      })
    })()
    return teardownPromise
  }
  const close = (reason: string): void => {
    if (closed.close(reason)) void teardown()
  }
  gone.onClosed(close)
  relay.onClosed(close)

  logger.info(
    `[rdp-tunnel] ${label} ready for session ${ctx.sessionId}; relay ${relay.host}:${relay.port}`,
  )

  return {
    host: relay.host,
    port: relay.port,
    close: async () => {
      close('closed by session')
      await teardown()
    },
    onClosed: (listener) => closed.onClosed(listener),
  }
}

/** What the RDP relay needs to know about tunnel routes in this process. */
export interface RdpTunnelSupport {
  /** Routes this process serves, or `undefined` when tunnels are not configured. */
  supportedKinds(): readonly RdpTunnelKind[] | undefined
  open(
    tunnel: RdpTunnel,
    ctx: { sessionId: string; guacdHost: string; relayToken: string; forwardRoutingToken?: string },
  ): Promise<RdpTunnelHandle>
  /**
   * Check a direct connection's hostname (see `rdp-direct-target.ts`) where
   * tunnel relays run; resolves `undefined` without checking elsewhere.
   */
  checkDirectTarget(hostname: string, ctx: { guacdHost: string }): Promise<string | undefined>
}

export function createRdpTunnelSupport(
  env: NodeJS.ProcessEnv = process.env,
  deps: { openTunnel?: typeof openRdpTunnel; checkDirectTarget?: typeof checkDirectRdpTarget } = {},
): RdpTunnelSupport {
  const open = deps.openTunnel ?? openRdpTunnel
  const checkDirect = deps.checkDirectTarget ?? checkDirectRdpTarget
  return {
    supportedKinds: () => detectRdpTunnelKinds({ env }),
    open: async (tunnel, ctx) => {
      const listenMode = resolveRdpTunnelListenMode(env)
      if (!listenMode) {
        throw new Error('RDP tunnel relay is not configured for this agent')
      }
      return open(tunnel, { ...ctx, listenMode })
    },
    checkDirectTarget: async (hostname, ctx) => {
      const listenMode = resolveRdpTunnelListenMode(env)
      // Only where this agent runs tunnel relays (K8s / ECS / Docker form):
      // that is what a direct target could be aimed at. A CLI install or an
      // external guacd keeps its previous behaviour — no check.
      if (!listenMode) return undefined
      return checkDirect(hostname, { listenMode, guacdHost: ctx.guacdHost })
    },
  }
}
