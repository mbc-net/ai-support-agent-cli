/**
 * Tailscale route for Web RDP: one userspace `tailscaled` per session, and one
 * `tailscale nc` per relayed connection.
 *
 * The daemon runs with `--tun=userspace-networking` (no TUN device, no root, no
 * change to the agent container's networking), keeps its node state in memory
 * (`--state=mem:`) and its socket/scratch files in a private 0700 temp
 * directory. The session joins the tailnet with `tailscale up`; each
 * connection guacd opens is carried by `tailscale --socket=<that socket> nc
 * <target.host> <target.port>`, whose stdin/stdout become the tunnel stream.
 * On close the nc processes are killed, the node logs out (it disappears when
 * the key is ephemeral) and the daemon stops.
 *
 * :::danger TCP の待ち受けを開かない
 * An earlier version exposed tailscaled's SOCKS5 proxy on a random loopback
 * port. SOCKS5 there has no authentication, so any process on the host could
 * reach any address on the tailnet through it. Now the only way in is the unix
 * socket inside the 0700 directory, and the destination is fixed to
 * `target` because the agent builds the `nc` arguments itself.
 * :::
 *
 * :::danger authkey はコマンドラインに載せない
 * Anything on argv is visible to every user on the host through `ps` /
 * `/proc/<pid>/cmdline`. The key is written to a 0600 file inside the 0700 temp
 * directory and handed over as `--auth-key=file:<path>`; the file is deleted as
 * soon as `tailscale up` returns. Nothing here logs the key, and error messages
 * built here carry command output, never argv values that could hold it.
 * :::
 *
 * Every subprocess is tracked by the child-process reaper, so none outlives
 * the agent.
 *
 * Operations requirement (documented in admin-docs): the auth key must be
 * ephemeral, pre-authorized and tagged, so that a session that dies without
 * logging out leaves no long-lived node behind.
 */

import { spawn, execFile, type ChildProcess } from 'child_process'
import { promises as fsp } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { SSM_PORT_POLL_INTERVAL_MS } from '../constants'
import { logger } from '../logger'
import { killSubprocess } from '../mcp/tools/db-ssm-tunnel'
import { getErrorMessage } from '../utils'
import { trackChildProcess } from '../utils/child-process-reaper'
import { createClosedSignal } from '../utils/closed-signal'
import { captureStderrTail } from '../utils/stderr-tail'
import { openStdioStream } from '../utils/stdio-stream'
import { waitUntil } from '../utils/wait-until'
import type { RdpTailscaleTunnel } from './rdp-tunnel-message'
import type { RdpTunnelDialer } from './rdp-tunnel'

/** Budget for tailscaled to come up, for `tailscale up` to join, and for nc to start. */
export const TAILSCALE_JOIN_TIMEOUT_MS = 30_000
/** Budget for `tailscale logout` during teardown. */
export const TAILSCALE_LOGOUT_TIMEOUT_MS = 10_000
const NODE_NAME_PREFIX = 'ais-rdp-'
const NODE_NAME_MAX_ID_LENGTH = 40

export interface TailscaleDialerDeps {
  /** Start `tailscaled` with the given args. */
  spawnDaemon?: (args: string[]) => ChildProcess
  /** Run the `tailscale` CLI; rejects with the command's stderr. */
  runCli?: (args: string[], timeoutMs: number) => Promise<void>
  /** Start `tailscale <args>` with piped stdio (used for `nc`). */
  spawnNc?: (args: string[]) => ChildProcess
  /** Resolve once tailscaled's socket exists; reject if the daemon died. */
  waitForReady?: (socketPath: string, timeoutMs: number, isAlive: () => boolean) => Promise<void>
  /** Parent of the per-session temp directory. */
  tmpRoot?: string
  timeoutMs?: number
  /** See `StdioStreamOptions.settleMs`. */
  stdioSettleMs?: number
}

export function tailscaleNodeName(sessionId: string): string {
  const id = sessionId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, NODE_NAME_MAX_ID_LENGTH)
  return `${NODE_NAME_PREFIX}${id}`
}

/**
 * Start `tailscaled`. stdin/stdout ignored; stderr piped for diagnostics.
 *
 * `env` is passed explicitly so the lookup follows the `process.env` the
 * caller sees (the one the heartbeat's PATH check used), not a snapshot taken
 * elsewhere.
 */
export function spawnTailscaled(args: string[], bin = 'tailscaled'): ChildProcess {
  return trackChildProcess(spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: process.env }))
}

/** Start the `tailscale` CLI with piped stdio — the carrier for `tailscale nc`. */
export function spawnTailscaleNc(args: string[], bin = 'tailscale'): ChildProcess {
  return trackChildProcess(spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env }))
}

/** Run the `tailscale` CLI. The rejection carries stderr, which never holds the key. */
export function runTailscaleCli(
  args: string[],
  timeoutMs: number,
  bin = 'tailscale',
): Promise<void> {
  return new Promise((resolve, reject) => {
    trackChildProcess(
      execFile(bin, args, { timeout: timeoutMs, env: process.env }, (error, _stdout, stderr) => {
        if (!error) {
          resolve()
          return
        }
        const detail = String(stderr ?? '').trim()
        reject(new Error(detail || error.message))
      }),
    )
  })
}

/** Wait until tailscaled has created its LocalAPI unix socket. */
export function waitForSocketFile(
  socketPath: string,
  timeoutMs: number,
  isAlive: () => boolean,
): Promise<void> {
  return waitUntil(
    async () => {
      try {
        return (await fsp.stat(socketPath)).isSocket()
      } catch {
        return false
      }
    },
    {
      timeoutMs,
      intervalMs: SSM_PORT_POLL_INTERVAL_MS,
      isAlive,
      deadMessage: 'tailscaled exited before it was ready',
      timeoutMessage: `Timed out waiting for tailscaled to open its socket after ${timeoutMs}ms`,
    },
  )
}

/**
 * Join the tailnet in a fresh userspace `tailscaled` and return a dialer that
 * reaches `tunnel.target` through it.
 *
 * On any failure the daemon is stopped and the temp directory removed before
 * the error propagates — nothing is left running for a session that never
 * started.
 */
export async function openTailscaleRdpDialer(
  tunnel: RdpTailscaleTunnel,
  ctx: { sessionId: string },
  deps: TailscaleDialerDeps = {},
): Promise<RdpTunnelDialer> {
  const spawnDaemon = deps.spawnDaemon ?? ((args: string[]) => spawnTailscaled(args))
  const runCli = deps.runCli ?? ((args: string[], t: number) => runTailscaleCli(args, t))
  const spawnNc = deps.spawnNc ?? ((args: string[]) => spawnTailscaleNc(args))
  const waitForReady = deps.waitForReady ?? waitForSocketFile
  const timeoutMs = deps.timeoutMs ?? TAILSCALE_JOIN_TIMEOUT_MS
  const label = `session ${ctx.sessionId}, ${tunnel.target.host}:${tunnel.target.port}`

  // mkdtemp creates the directory 0700: the socket and the key file inside are
  // not reachable by other users even before their own modes apply.
  const workDir = await fsp.mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), 'ais-rdp-ts-'))
  const socketPath = path.join(workDir, 'tailscaled.sock')
  const socketArg = `--socket=${socketPath}`

  let child: ChildProcess
  try {
    child = spawnDaemon([
      '--tun=userspace-networking',
      '--state=mem:',
      `--statedir=${workDir}`,
      socketArg,
      // A fixed UDP port (41641) would collide between concurrent sessions.
      '--port=0',
    ])
  } catch (error) {
    // Nothing is running, but the directory exists: remove it.
    await fsp.rm(workDir, { recursive: true, force: true })
    throw error
  }

  const stderrTail = captureStderrTail(child.stderr)
  const gone = createClosedSignal()
  child.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    gone.close(`tailscaled exited (code=${code}, signal=${signal})`)
  })
  // Without a listener an 'error' event would crash the long-lived agent
  // process. A spawn failure (no pid, e.g. ENOENT) emits 'error' and never
  // 'exit': treat it as gone, or the join would wait out its whole timeout.
  child.on('error', (err: Error) => {
    logger.error(`[rdp-tunnel] tailscaled error (session ${ctx.sessionId}): ${err.message}`)
    if (child.pid === undefined) gone.close(`tailscaled could not be started: ${err.message}`)
  })

  const ncChildren = new Set<ChildProcess>()
  let teardown: Promise<void> | null = null
  const close = (): Promise<void> => {
    teardown ??= (async () => {
      await Promise.all([...ncChildren].map((nc) => killSubprocess(nc)))
      if (!gone.isClosed) {
        try {
          await runCli([socketArg, 'logout'], TAILSCALE_LOGOUT_TIMEOUT_MS)
        } catch (error) {
          // Keep going: the daemon must still be stopped. An ephemeral key
          // removes the node on its own once it goes offline.
          logger.warn(
            `[rdp-tunnel] tailscale logout failed (session ${ctx.sessionId}): ${getErrorMessage(error)}`,
          )
        }
        await killSubprocess(child)
      }
      await fsp.rm(workDir, { recursive: true, force: true })
    })()
    return teardown
  }

  try {
    await waitForReady(socketPath, timeoutMs, () => !gone.isClosed)
    const keyFile = path.join(workDir, 'authkey')
    await fsp.writeFile(keyFile, tunnel.via.authKey, { mode: 0o600 })
    try {
      await runCli(
        [
          socketArg,
          'up',
          `--auth-key=file:${keyFile}`,
          `--hostname=${tailscaleNodeName(ctx.sessionId)}`,
          `--timeout=${Math.ceil(timeoutMs / 1000)}s`,
        ],
        timeoutMs,
      )
    } finally {
      await fsp.rm(keyFile, { force: true })
    }
  } catch (error) {
    const message = `Tailscale could not join the tailnet: ${getErrorMessage(error)}${stderrTail()}`
    await close()
    throw new Error(message)
  }

  logger.debug(
    `[rdp-tunnel] tailscaled joined for session ${ctx.sessionId} (via ${tunnel.via.hostId})`,
  )

  return {
    dial: () => {
      const nc = spawnNc([socketArg, 'nc', tunnel.target.host, String(tunnel.target.port)])
      ncChildren.add(nc)
      nc.once('exit', () => ncChildren.delete(nc))
      return openStdioStream(nc, {
        label: `tailscale nc (${label})`,
        timeoutMs,
        settleMs: deps.stdioSettleMs,
      })
    },
    close,
    onClosed: (listener) => gone.onClosed(listener),
  }
}
