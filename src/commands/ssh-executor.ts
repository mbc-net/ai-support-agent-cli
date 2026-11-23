import { createSshHostVerifier } from '../utils/ssh-host-key'
/**
 * Ad-hoc SSH command executor used by the `ssh_exec` command handler (see
 * `commands/index.ts`). Ports the timeout / stdout+stderr aggregation /
 * exit-code formatting logic from `api/src/llm/tools/ssh.tool.ts`'s
 * `executeViaSsh`, and additionally supports routing the SSH TCP connection
 * through a Tailscale sidecar's SOCKS5 proxy (see admin-docs
 * `docs/specifications/ssh-tailscale-support.md`, section 2).
 *
 * When the resolved credential's `connectionType` is `'tailscale'`, a SOCKS5
 * socket to `tailnetHostname:port` is established first (via the `socks`
 * package, talking to the ECS oneshot task's `tailscaled` sidecar on
 * `127.0.0.1:<socksPort>`) and handed to ssh2's `Client.connect({ sock })`.
 * Otherwise ssh2 connects directly to `hostname`/`port` as before.
 *
 * Fallback禁止 (see CLAUDE.md / the design doc's "フォールバック禁止"
 * section): a failed SOCKS5 hop is a hard failure — this never falls back
 * to a direct, non-Tailscale connection.
 *
 * `ssh2`/`socks` are loaded via dynamic `import()` so agents that never run
 * `ssh_exec` do not pay their require() cost at startup, mirroring the
 * lazy-load pattern used for `ecs-launcher`/`server-setup-runner` in
 * `commands/index.ts`.
 *
 * SECURITY: `credential.privateKey` (holds either the SSH private key or a
 * password, depending on `authType`) and `credential.tailscaleAuthKey` must
 * never be logged.
 */

import { DEFAULT_SSH_PORT, LOCALHOST_ADDRESS, TAILSCALE_SOCKS_PORT } from '../constants'
import { logger } from '../logger'
import { isSupportedSshAuthType, unsupportedSshAuthTypeMessage, type SshExecCredential } from '../types'
import { getErrorMessage } from '../utils'

/** Default timeout when the caller/payload does not specify one. */
export const DEFAULT_SSH_EXEC_TIMEOUT_SECONDS = 30

/**
 * Default SOCKS5 listen port for the Tailscale sidecar (design doc section 2).
 * Re-exported from `constants.ts`'s `TAILSCALE_SOCKS_PORT` — the single
 * source of truth also used by `server-setup-runner.ts` and
 * `task-definition-registrar.ts` — so this module keeps its existing export
 * name for callers that already import `DEFAULT_TAILSCALE_SOCKS_PORT` from here.
 */
export const DEFAULT_TAILSCALE_SOCKS_PORT = TAILSCALE_SOCKS_PORT

/**
 * Establish a SOCKS5-proxied TCP socket to the tailnet host, via the
 * `tailscaled --socks5-server` sidecar listening on `127.0.0.1:<socksPort>`.
 * Never falls back to a direct connection on failure.
 */
async function createTailscaleSocksSocket(credential: SshExecCredential): Promise<unknown> {
  if (!credential.tailnetHostname) {
    throw new Error('Tailscale connection requires tailnetHostname')
  }
  const destinationPort = credential.port || DEFAULT_SSH_PORT
  const socksPort = credential.socksPort ?? DEFAULT_TAILSCALE_SOCKS_PORT

  logger.debug(
    `[ssh-executor] Connecting via Tailscale SOCKS5 proxy 127.0.0.1:${socksPort} -> ${credential.tailnetHostname}:${destinationPort}`,
  )

  const { SocksClient } = await import('socks')
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: LOCALHOST_ADDRESS,
        port: socksPort,
        type: 5,
      },
      command: 'connect',
      destination: {
        host: credential.tailnetHostname,
        port: destinationPort,
      },
    })
    return socket
  } catch (error) {
    throw new Error(`Failed to establish Tailscale SOCKS5 connection: ${getErrorMessage(error)}`)
  }
}

/** Validated credential → ssh2 Client constructor + connect config (no connection opened yet). */
async function prepareSshConnection(
  credential: SshExecCredential,
  timeoutSeconds: number,
  options: { hostKeyAlgorithms?: readonly string[] },
): Promise<{ Client: typeof import('ssh2').Client; connectConfig: Record<string, unknown> }> {
  if (!credential.hostname || !credential.username || !credential.authType) {
    throw new Error('SSH connection requires hostname, username, and authType to be set')
  }
  // `authType` decides whether `credential.privateKey` (an overloaded field,
  // see this file's doc comment) is SSH key material or a plaintext
  // password. An unrecognized authType must never silently fall back to the
  // key path (フォールバック禁止) — shares `isSupportedSshAuthType` with
  // server-setup-runner.ts's validateSshCredential, which guards the same
  // overloaded field for the `server_setup_exec` command.
  if (!isSupportedSshAuthType(credential.authType)) {
    throw new Error(unsupportedSshAuthTypeMessage(credential.authType))
  }

  // Resolved (and, for Tailscale, connected) before the ssh2 Client is even
  // constructed: a SOCKS5 failure must surface as-is, not as a subsequent
  // ssh2 'error' event that could read as a plain connection error.
  const hostVerifier = createSshHostVerifier(credential.hostKeyFingerprint)

  const sock = credential.connectionType === 'tailscale'
    ? await createTailscaleSocksSocket(credential)
    : undefined

  const { Client } = await import('ssh2')

  const connectConfig: Record<string, unknown> = {
    hostVerifier,
    username: credential.username,
    readyTimeout: timeoutSeconds * 1000,
    ...(credential.authType === 'password'
      ? { password: credential.privateKey }
      : { privateKey: credential.privateKey }),
  }
  if (options.hostKeyAlgorithms) {
    connectConfig.algorithms = { serverHostKey: [...options.hostKeyAlgorithms] }
  }

  if (sock) {
    connectConfig.sock = sock
  } else {
    connectConfig.host = credential.hostname
    connectConfig.port = credential.port || DEFAULT_SSH_PORT
  }
  return { Client, connectConfig }
}

/**
 * Execute `command` over SSH against the host described by `credential`,
 * returning combined stdout/stderr formatted the same way as the api-side
 * `SshTool.executeViaSsh`: plain stdout on a clean (0) exit, or an
 * "Exit code: N\nSTDOUT:\n...\nSTDERR:\n..." block otherwise.
 *
 * `options.hostKeyAlgorithms` restricts host-key negotiation to the algorithms
 * that present the pinned key's type, so a pin taken from known_hosts (one
 * key type) is not defeated by the server offering a different type first.
 */
export async function executeSshCommand(
  credential: SshExecCredential,
  command: string,
  timeoutSeconds: number = DEFAULT_SSH_EXEC_TIMEOUT_SECONDS,
  options: { hostKeyAlgorithms?: readonly string[] } = {},
): Promise<string> {
  const { Client, connectConfig } = await prepareSshConnection(credential, timeoutSeconds, options)

  return new Promise<string>((resolve, reject) => {
    const conn = new Client()
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      conn.end()
      reject(new Error(`SSH command timed out after ${timeoutSeconds}s`))
    }, timeoutSeconds * 1000)

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          conn.end()
          reject(err)
          return
        }

        stream.on('close', (code: number) => {
          clearTimeout(timer)
          conn.end()
          if (timedOut) return

          if (code !== 0 && stderr) {
            resolve(`Exit code: ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`)
          } else if (code !== 0) {
            resolve(`Exit code: ${code}\nSTDOUT:\n${stdout}`)
          } else {
            resolve(stdout)
          }
        })

        stream.on('data', (data: Buffer) => {
          stdout += data.toString()
        })

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString()
        })
      })
    })

    conn.on('error', (err) => {
      clearTimeout(timer)
      if (timedOut) return
      reject(err)
    })

    conn.connect(connectConfig)
  })
}

/** Options of executeSshCommandStreaming. */
export interface SshStreamingOptions {
  /** Restrict host-key negotiation (see executeSshCommand). */
  hostKeyAlgorithms?: readonly string[]
  /** Called for every stdout line (without the trailing `\n`), in order. */
  onLine: (line: string) => void
  /** Stop reading (and close the connection) after this many stdout bytes. */
  maxBytes: number
  /** A longer line is cut to this many bytes (default 64 KiB) so one line cannot hold the whole stream. */
  maxLineBytes?: number
  /** stderr kept for the result (default 4 KiB). */
  maxStderrBytes?: number
}

export interface SshStreamingResult {
  /** Remote exit code; null when the stream was cut at maxBytes (or no code was reported). */
  exitCode: number | null
  /** stderr, cut to maxStderrBytes. */
  stderr: string
  /** True when reading stopped at maxBytes; the partial last line is dropped. */
  truncated: boolean
}

const DEFAULT_STREAM_MAX_LINE_BYTES = 64 * 1024
const DEFAULT_STREAM_MAX_STDERR_BYTES = 4096

/**
 * Opt-in streaming variant of executeSshCommand for large outputs: stdout is
 * never accumulated, it is split into lines and handed to `options.onLine`.
 * Reading stops after `options.maxBytes` stdout bytes (the connection is
 * closed and the result is marked truncated). Same connection, host-key and
 * timeout handling as executeSshCommand, which is unchanged.
 */
export async function executeSshCommandStreaming(
  credential: SshExecCredential,
  command: string,
  timeoutSeconds: number,
  options: SshStreamingOptions,
): Promise<SshStreamingResult> {
  const { Client, connectConfig } = await prepareSshConnection(credential, timeoutSeconds, options)
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_STREAM_MAX_LINE_BYTES
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STREAM_MAX_STDERR_BYTES

  return new Promise<SshStreamingResult>((resolve, reject) => {
    const conn = new Client()
    let settled = false
    let received = 0
    let pending: Buffer[] = []
    let pendingBytes = 0
    let stderr = Buffer.alloc(0)

    const finish = (settle: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.end()
      settle()
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`SSH command timed out after ${timeoutSeconds}s`)))
    }, timeoutSeconds * 1000)

    const appendPending = (part: Buffer): void => {
      const room = maxLineBytes - pendingBytes
      if (room <= 0) return
      const kept = part.length > room ? part.subarray(0, room) : part
      pending.push(kept)
      pendingBytes += kept.length
    }
    const emitLine = (): void => {
      const line = Buffer.concat(pending).toString('utf8')
      pending = []
      pendingBytes = 0
      options.onLine(line)
    }

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          finish(() => reject(err))
          return
        }

        stream.on('data', (data: Buffer) => {
          if (settled) return
          let chunk = data
          if (received + chunk.length > options.maxBytes) chunk = chunk.subarray(0, options.maxBytes - received)
          received += chunk.length
          try {
            let start = 0
            let newline = chunk.indexOf(0x0a, start)
            while (newline >= 0) {
              appendPending(chunk.subarray(start, newline))
              emitLine()
              start = newline + 1
              newline = chunk.indexOf(0x0a, start)
            }
            appendPending(chunk.subarray(start))
          } catch (error) {
            finish(() => reject(error))
            return
          }
          if (received >= options.maxBytes) {
            // The partial last line is dropped: it may be cut mid-line.
            pending = []
            pendingBytes = 0
            finish(() => resolve({ exitCode: null, stderr: stderr.toString('utf8'), truncated: true }))
          }
        })

        stream.stderr.on('data', (data: Buffer) => {
          const room = maxStderrBytes - stderr.length
          if (room > 0) stderr = Buffer.concat([stderr, data.subarray(0, room)])
        })

        stream.on('close', (code: unknown) => {
          if (settled) return
          try {
            if (pendingBytes > 0) emitLine()
          } catch (error) {
            finish(() => reject(error))
            return
          }
          finish(() =>
            resolve({
              exitCode: typeof code === 'number' ? code : null,
              stderr: stderr.toString('utf8'),
              truncated: false,
            }),
          )
        })
      })
    })

    conn.on('error', (err) => {
      finish(() => reject(err))
    })

    conn.connect(connectConfig)
  })
}
