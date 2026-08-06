/**
 * Plain-SSH local port forward used by the `db_query` / `get_db_schemas` MCP
 * tools when a DB connection is configured to be reached through a bastion
 * (see `DbCredentials.ssh`). Opens an ssh2 tunnel and a local TCP listener,
 * so mysql2/pg can connect to `127.0.0.1:<localPort>` and have traffic
 * forwarded to the real database host over the SSH channel.
 *
 * Scope: plain SSH only. SSM (P2) and Tailscale are out of scope here; the
 * Tailscale SOCKS5 path lives in `commands/ssh-executor.ts`.
 *
 * Fallback禁止 (see CLAUDE.md): missing/invalid SSH credential material or a
 * failed SSH connect is a hard error — never a silent direct connection.
 *
 * Lifecycle: the caller (`executeQueryWithTunnel`) opens one tunnel per query
 * and always `close()`s it in a `finally`, so the listener/SSH connection do
 * not leak across queries even though the agent process is long-lived.
 *
 * `ssh2` is loaded via dynamic `import()` (mirroring `ssh-executor.ts`) so
 * agents that never query a tunneled DB do not pay its require() cost at
 * startup.
 *
 * SECURITY: `ssh.privateKey` (holds SSH key material or, for password auth, a
 * plaintext password) must never be logged.
 */

import { createServer, type Socket } from 'net'

import {
  DB_CONNECT_TIMEOUT_MS,
  SSH_KEEPALIVE_COUNT_MAX,
  SSH_KEEPALIVE_INTERVAL_MS,
} from '../../constants'
import { logger } from '../../logger'
import { isSupportedSshAuthType, type SshCredentials } from '../../types'
import { getAddressPort } from '../../utils'

/** A live SSH local port forward. Connect to `host:port`; call `close()` when done. */
export interface DbTunnel {
  host: string
  port: number
  close: () => Promise<void>
}

/** The remote endpoint a tunnel forwards to. */
export interface TunnelTarget {
  host: string
  port: number
}

/**
 * Open a plain SSH tunnel (local port forward) to `target` via the bastion
 * described by `ssh`. Returns the local endpoint to connect to and a `close()`
 * that tears down both the local listener and the SSH connection.
 */
export async function openSshTunnel(
  ssh: SshCredentials,
  target: TunnelTarget,
): Promise<DbTunnel> {
  if (!ssh.hostname || !ssh.username || !ssh.authType) {
    throw new Error('SSH tunnel requires hostname, username, and authType to be set')
  }
  // An unrecognized authType must never silently fall back to the key path
  // (フォールバック禁止) — shares `isSupportedSshAuthType` with
  // ssh-executor.ts / server-setup-runner.ts.
  if (!isSupportedSshAuthType(ssh.authType)) {
    throw new Error(`SSH credential authType is not supported: ${JSON.stringify(ssh.authType)}`)
  }

  const { Client } = await import('ssh2')

  const conn = await new Promise<InstanceType<typeof Client>>((resolve, reject) => {
    const client = new Client()
    // The initial 'error' handler rejects the connect promise. Once 'ready'
    // fires we must remove it and install a permanent handler, otherwise a
    // later SSH-level error (e.g. the bastion dropping the connection after the
    // tunnel is established) is silently swallowed — or, worse, surfaces as an
    // unhandled 'error' event that crashes the long-lived agent process.
    const onConnectError = (err: Error) => reject(err)
    client.once('ready', () => {
      client.removeListener('error', onConnectError)
      client.on('error', (err: Error) => {
        logger.error(
          `[db-tunnel] SSH connection error after tunnel established (via ${ssh.hostId}): ${err.message}`,
        )
      })
      resolve(client)
    })
    client.once('error', onConnectError)

    const connectConfig: Record<string, unknown> = {
      host: ssh.hostname,
      port: ssh.port || 22,
      username: ssh.username,
      readyTimeout: DB_CONNECT_TIMEOUT_MS,
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
      ...(ssh.authType === 'password'
        ? { password: ssh.privateKey }
        : { privateKey: ssh.privateKey }),
    }
    client.connect(connectConfig)
  })

  const server = createServer((socket: Socket) => {
    conn.forwardOut('127.0.0.1', 0, target.host, target.port, (err, stream) => {
      if (err) {
        // Surface why the forward channel could not be opened (bastion refused,
        // target unreachable, channel limit) — SSH key material is not part of
        // this error, so it is safe to log.
        logger.error(
          `[db-tunnel] Failed to open forward channel to ${target.host}:${target.port} (via ${ssh.hostId}): ${err.message}`,
        )
        socket.destroy()
        return
      }
      // CRITICAL: pipe() does not forward 'error' events. Without an 'error'
      // listener on both the local socket and the SSH stream, a mid-stream
      // failure (client reset, SSH channel drop) becomes an uncaughtException
      // that terminates the long-lived agent/worker process. Handle it
      // per-connection: log and tear down just this pair, leaving the tunnel
      // (and the process) up for other connections.
      const onPipeError = (side: 'local socket' | 'SSH stream') => (pipeErr: Error) => {
        logger.error(
          `[db-tunnel] Tunnel ${side} error for ${target.host}:${target.port} (via ${ssh.hostId}): ${pipeErr.message}`,
        )
        socket.destroy()
        stream.destroy()
      }
      socket.on('error', onPipeError('local socket'))
      stream.on('error', onPipeError('SSH stream'))
      socket.pipe(stream).pipe(socket)
    })
  })

  const localPort = await new Promise<number>((resolve, reject) => {
    // If the local listener cannot bind (or the address is unreadable), the SSH
    // connection is already established — end it before rejecting so a repeated
    // bind failure cannot leak bastion sessions in the long-lived process.
    server.on('error', (err) => {
      conn.end()
      reject(err)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = getAddressPort(server)
      if (port !== undefined) {
        resolve(port)
      } else {
        conn.end()
        reject(new Error('Failed to determine local tunnel port'))
      }
    })
  })

  logger.debug(
    `[db-tunnel] SSH tunnel established 127.0.0.1:${localPort} -> ${target.host}:${target.port} via ${ssh.hostId}`,
  )

  return {
    host: '127.0.0.1',
    port: localPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          conn.end()
          resolve()
        })
      }),
  }
}
