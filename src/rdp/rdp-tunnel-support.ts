import * as fs from 'fs'
import * as path from 'path'

import { detectAgentRuntime } from '../capability/capability-plan'
import { ENV_VARS } from '../constants'
import type { RdpTunnelKind } from './rdp-tunnel-message'

/**
 * Which RDP tunnel routes this agent process can serve (api ⇔ agent contract 2).
 *
 * The answer is reported on the heartbeat (`rdpTunnels`) and the same function
 * gates `rdp_open`, so the API is never told "yes" for a route the relay would
 * then refuse.
 */

/**
 * Where the relay listens for guacd.
 *
 * - `loopback` — K8s / ECS: guacd is a sidecar sharing the network namespace.
 * - `docker-network` — Docker form: guacd is the `ais-guacd` container on the
 *   `ais-rdp` network; the relay listens on this container's address there
 *   and admits only guacd's address.
 */
export type RdpTunnelListenMode = 'loopback' | 'docker-network'

const LISTEN_MODES: readonly RdpTunnelListenMode[] = ['loopback', 'docker-network']

/**
 * The relay's listen mode, or `undefined` when tunnel routes must be refused.
 *
 * :::danger 自動判定しない
 * The mode comes only from the explicit setting that the manifests and
 * `buildGuacdDockerArgs` inject. Guessing it would either listen where guacd
 * cannot reach (the session just hangs) or open an unauthenticated relay into
 * the customer network to peers that are not guacd.
 * :::
 *
 * A host (CLI) install is refused even with the setting present: stage 1 does
 * not support tunnels there (an externally run guacd could be anywhere).
 */
export function resolveRdpTunnelListenMode(
  env: NodeJS.ProcessEnv = process.env,
): RdpTunnelListenMode | undefined {
  const value = env[ENV_VARS.RDP_TUNNEL_LISTEN]
  if (!LISTEN_MODES.includes(value as RdpTunnelListenMode)) return undefined
  if (detectAgentRuntime(env) === 'host') return undefined
  return value as RdpTunnelListenMode
}

/** Whether an executable file named `name` exists on `env.PATH`. */
export function hasExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const dirs = (env.PATH ?? '').split(path.delimiter).filter((dir) => dir.length > 0)
  return dirs.some((dir) => {
    const candidate = path.join(dir, name)
    try {
      if (!fs.statSync(candidate).isFile()) return false
      fs.accessSync(candidate, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  })
}

/** External commands each route needs besides the bundled `ssh2`. */
const REQUIRED_COMMANDS: Record<Exclude<RdpTunnelKind, 'ssh'>, readonly string[]> = {
  ssm: ['aws', 'session-manager-plugin'],
  tailscale: ['tailscaled', 'tailscale'],
}

export interface DetectRdpTunnelKindsOptions {
  env?: NodeJS.ProcessEnv
  /** Injected for tests; defaults to a PATH lookup in `env`. */
  hasCommand?: (name: string) => boolean
}

/**
 * The routes this process can serve.
 *
 * @returns `undefined` when tunnels are not configured for this form at all —
 *   the heartbeat then omits `rdpTunnels`, exactly like an agent that predates
 *   the feature, and the API refuses tunnel routes.
 */
export function detectRdpTunnelKinds(
  options: DetectRdpTunnelKindsOptions = {},
): RdpTunnelKind[] | undefined {
  const env = options.env ?? process.env
  if (!resolveRdpTunnelListenMode(env)) return undefined
  const hasCommand = options.hasCommand ?? ((name: string) => hasExecutableOnPath(name, env))

  const kinds: RdpTunnelKind[] = ['ssh']
  for (const kind of ['ssm', 'tailscale'] as const) {
    if (REQUIRED_COMMANDS[kind].every((name) => hasCommand(name))) kinds.push(kind)
  }
  return kinds
}
