/**
 * SSM port-forwarding tunnel used by the `db_query` / `get_db_schemas` MCP tools
 * when the selected DB SSH host is of connectionType `'ssm'` (see
 * `SshCredentials.connectionType`). Instead of a plain SSH channel
 * (`db-tunnel.ts`), this opens a local port forward through
 * `aws ssm start-session ... AWS-StartPortForwardingSessionToRemoteHost`
 * (session-manager-plugin), so mysql2/pg can connect to `127.0.0.1:<localPort>`
 * and have traffic forwarded to the real database host via SSM.
 *
 * Returns the same `{ host, port, close }` (`DbTunnel`) interface as
 * `openSshTunnel`, so `executeQueryWithTunnel` treats both transports
 * uniformly.
 *
 * Fallback禁止 (see CLAUDE.md): missing instanceId/region/awsCredentials or a
 * subprocess that never opens the port is a hard error — never a silent direct
 * connection.
 *
 * Lifecycle: the caller (`executeQueryWithTunnel`) opens one tunnel per query
 * and always `close()`s it in a `finally`, so the session-manager-plugin
 * subprocess does not leak across queries even though the agent process is
 * long-lived.
 *
 * SECURITY: `awsCredentials` (access key / secret / session token) are passed to
 * the subprocess only via env and must never be logged. stdin and stdout (the
 * forwarded data) are ignored so no forwarded payload can reach the agent logs
 * and a full stdout pipe can never block the long-running session; only stderr
 * is captured (size-bounded) so a failed handshake's reason — plugin missing,
 * TargetNotConnected, AccessDenied — is surfaced in the thrown error instead of
 * being silently discarded. AWS credentials travel via env, not stderr, so the
 * captured tail does not contain them.
 */

import { spawn, type ChildProcess } from 'child_process'
import { createServer, Socket } from 'net'

import {
  DB_CONNECT_TIMEOUT_MS,
  LOCALHOST_ADDRESS,
  SSM_KILL_GRACE_MS,
  SSM_PORT_POLL_INTERVAL_MS,
  SSM_PORT_PROBE_TIMEOUT_MS,
  SSM_STDERR_MAX_BYTES,
} from '../../constants'
import { logger } from '../../logger'
import type { SsmAwsCredentials } from '../../types/project'
import { getAddressPort } from '../../utils'
import { buildAwsCredentialEnv } from '../../utils/aws-credential-env'
import type { DbTunnel, TunnelTarget } from './db-tunnel'

export interface SsmTunnelParams {
  instanceId: string
  region: string
  awsCredentials: SsmAwsCredentials
  target: TunnelTarget
  /** Total budget for the local forwarded port to start accepting connections. */
  timeoutMs?: number
}

/** Reserve an ephemeral local port by briefly binding and releasing it. */
function reserveLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, LOCALHOST_ADDRESS, () => {
      const port = getAddressPort(server)
      if (port !== undefined) {
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('Failed to reserve a local tunnel port')))
      }
    })
  })
}

/** Attempt a single TCP connection to the local forwarded port; resolves true on success. */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(SSM_PORT_PROBE_TIMEOUT_MS)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.once('timeout', () => finish(false))
    socket.connect(port, LOCALHOST_ADDRESS)
  })
}

/**
 * Terminate the session-manager-plugin subprocess: SIGTERM first, escalating to
 * SIGKILL if it has not exited within the grace window. Resolves once the
 * process is confirmed gone (or was already gone).
 */
function killSubprocess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    let done = false
    let killTimer: NodeJS.Timeout | undefined
    const finish = () => {
      if (done) return
      done = true
      if (killTimer) clearTimeout(killTimer)
      resolve()
    }
    child.once('exit', finish)
    child.kill('SIGTERM')
    killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      finish()
    }, SSM_KILL_GRACE_MS)
  })
}

/**
 * Open an SSM local port forward to `target` on `instanceId`. Returns the local
 * endpoint to connect to and a `close()` that tears down the subprocess.
 */
export async function openSsmTunnel(params: SsmTunnelParams): Promise<DbTunnel> {
  const { instanceId, region, awsCredentials, target } = params
  if (!instanceId || !region) {
    throw new Error('SSM tunnel requires instanceId and region to be set')
  }
  if (!awsCredentials || !awsCredentials.accessKeyId || !awsCredentials.secretAccessKey) {
    throw new Error('SSM tunnel requires awsCredentials with accessKeyId and secretAccessKey')
  }

  const localPort = await reserveLocalPort()

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...buildAwsCredentialEnv(awsCredentials, region),
  }

  const args = [
    'ssm',
    'start-session',
    '--target',
    instanceId,
    '--document-name',
    'AWS-StartPortForwardingSessionToRemoteHost',
    '--parameters',
    `host=${target.host},portNumber=${target.port},localPortNumber=${localPort}`,
    '--region',
    region,
  ]

  // stdin/stdout ignored (see file-level SECURITY note); stderr piped so the
  // failure reason is available when the handshake never completes.
  const child = spawn('aws', args, { env, stdio: ['ignore', 'ignore', 'pipe'] })

  // Retain only the most recent SSM_STDERR_MAX_BYTES of stderr (the tail, where
  // the failure reason appears) so a chatty plugin cannot grow this unbounded.
  let stderrBuf = ''
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBuf += chunk.toString()
    if (stderrBuf.length > SSM_STDERR_MAX_BYTES) {
      stderrBuf = stderrBuf.slice(stderrBuf.length - SSM_STDERR_MAX_BYTES)
    }
  })
  const stderrTail = (): string => {
    const trimmed = stderrBuf.trim()
    return trimmed ? `: ${trimmed}` : ''
  }

  const timeoutMs = params.timeoutMs ?? DB_CONNECT_TIMEOUT_MS

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const deadline = Date.now() + timeoutMs
      let pollTimer: NodeJS.Timeout | undefined

      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        if (pollTimer) clearTimeout(pollTimer)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        if (err) reject(err)
        else resolve()
      }

      const onError = (err: Error) =>
        settle(new Error(`Failed to start the SSM session subprocess (aws/session-manager-plugin): ${err.message}${stderrTail()}`))
      const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
        settle(new Error(`SSM session subprocess exited before the port forward was ready (code=${code}, signal=${signal})${stderrTail()}`))

      child.once('error', onError)
      child.once('exit', onExit)

      const poll = async () => {
        if (settled) return
        const ok = await probePort(localPort)
        if (settled) return
        if (ok) {
          settle()
          return
        }
        if (Date.now() >= deadline) {
          settle(new Error(`Timed out waiting for the SSM port forward on 127.0.0.1:${localPort} after ${timeoutMs}ms${stderrTail()}`))
          return
        }
        pollTimer = setTimeout(poll, SSM_PORT_POLL_INTERVAL_MS)
      }
      void poll()
    })
  } catch (err) {
    await killSubprocess(child)
    throw err
  }

  // The temporary 'error'/'exit' listeners used during establishment were
  // removed on settle. Install a permanent log-only 'error' handler so a
  // post-establishment failure — a later subprocess crash, or a failing
  // child.kill() during close() — does not surface as an unhandled 'error'
  // event, which Node turns into an uncaughtException that would exit(1) the
  // long-lived agent/worker process. Mirrors db-tunnel.ts's ssh client, which
  // swaps its connect-time error handler for a permanent logger after 'ready'.
  // awsCredentials travel via env (never through this event), so err.message
  // is safe to log.
  child.on('error', (err: Error) => {
    logger.error(
      `[db-ssm-tunnel] SSM session subprocess error after port forward established (${instanceId}): ${err.message}`,
    )
  })

  logger.debug(
    `[db-ssm-tunnel] SSM port forward established 127.0.0.1:${localPort} -> ${target.host}:${target.port} via ${instanceId}`,
  )

  return {
    host: LOCALHOST_ADDRESS,
    port: localPort,
    close: () => killSubprocess(child),
  }
}
