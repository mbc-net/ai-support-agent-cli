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

import { logger } from '../logger'
import type { SshExecCredential } from '../types'
import { getErrorMessage } from '../utils'

/** Default timeout when the caller/payload does not specify one. */
export const DEFAULT_SSH_EXEC_TIMEOUT_SECONDS = 30

/** Default SOCKS5 listen port for the Tailscale sidecar (design doc section 2). */
export const DEFAULT_TAILSCALE_SOCKS_PORT = 1055

/**
 * Establish a SOCKS5-proxied TCP socket to the tailnet host, via the
 * `tailscaled --socks5-server` sidecar listening on `127.0.0.1:<socksPort>`.
 * Never falls back to a direct connection on failure.
 */
async function createTailscaleSocksSocket(credential: SshExecCredential): Promise<unknown> {
  if (!credential.tailnetHostname) {
    throw new Error('Tailscale connection requires tailnetHostname')
  }
  const destinationPort = credential.port || 22
  const socksPort = credential.socksPort ?? DEFAULT_TAILSCALE_SOCKS_PORT

  logger.debug(
    `[ssh-executor] Connecting via Tailscale SOCKS5 proxy 127.0.0.1:${socksPort} -> ${credential.tailnetHostname}:${destinationPort}`,
  )

  const { SocksClient } = await import('socks')
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: '127.0.0.1',
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

/**
 * Execute `command` over SSH against the host described by `credential`,
 * returning combined stdout/stderr formatted the same way as the api-side
 * `SshTool.executeViaSsh`: plain stdout on a clean (0) exit, or an
 * "Exit code: N\nSTDOUT:\n...\nSTDERR:\n..." block otherwise.
 */
export async function executeSshCommand(
  credential: SshExecCredential,
  command: string,
  timeoutSeconds: number = DEFAULT_SSH_EXEC_TIMEOUT_SECONDS,
): Promise<string> {
  if (!credential.hostname || !credential.username || !credential.authType) {
    throw new Error('SSH connection requires hostname, username, and authType to be set')
  }

  // Resolved (and, for Tailscale, connected) before the ssh2 Client is even
  // constructed: a SOCKS5 failure must surface as-is, not as a subsequent
  // ssh2 'error' event that could read as a plain connection error.
  const sock = credential.connectionType === 'tailscale'
    ? await createTailscaleSocksSocket(credential)
    : undefined

  const { Client } = await import('ssh2')

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

    const connectConfig: Record<string, unknown> = {
      username: credential.username,
      readyTimeout: timeoutSeconds * 1000,
      ...(credential.authType === 'password'
        ? { password: credential.privateKey }
        : { privateKey: credential.privateKey }),
    }

    if (sock) {
      connectConfig.sock = sock
    } else {
      connectConfig.host = credential.hostname
      connectConfig.port = credential.port || 22
    }

    conn.connect(connectConfig)
  })
}
