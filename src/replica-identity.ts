import * as crypto from 'crypto'

import { ENV_VARS } from './constants'

/**
 * Characters allowed in an instance id.
 *
 * The server embeds this value in a DynamoDB sort key
 * (`AGENT_INSTANCE#{projectCode}#DEVICE#{agentId}#INSTANCE#{instanceId}`) and
 * validates it with the same pattern, so `#` and other separators must not
 * appear. Kubernetes Pod names and ECS task ids already satisfy this.
 */
const ALLOWED_CHARS = /[^A-Za-z0-9._-]/g

/** Max length accepted by the server (`AGENT_INSTANCE_ID_PATTERN`). */
const MAX_LENGTH = 128

/**
 * Sanitize a candidate instance id, returning undefined when nothing usable
 * remains. Disallowed characters are replaced with `-` rather than dropped so
 * that two distinct hostnames cannot collapse into the same id.
 */
function sanitize(candidate: string | undefined): string | undefined {
  if (!candidate) return undefined
  const cleaned = candidate.trim().replace(ALLOWED_CHARS, '-').slice(0, MAX_LENGTH)
  // A value made entirely of separators carries no identity.
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : undefined
}

/**
 * Extract the ECS task id from the container metadata URI.
 *
 * `ECS_CONTAINER_METADATA_URI_V4` looks like
 * `http://169.254.170.2/v4/<task-id>-<container-id>`; the last path segment is
 * stable for the lifetime of the task, which is exactly the replica lifetime.
 * Reading the env var avoids an HTTP round-trip at startup.
 */
function ecsTaskIdFromMetadataUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined
  const segments = uri.split('/').filter(Boolean)
  return segments.length > 0 ? segments[segments.length - 1] : undefined
}

/**
 * Resolve this process's replica identity.
 *
 * Precedence:
 *   1. `AI_SUPPORT_AGENT_INSTANCE_ID` — explicit override (generated manifests
 *      set this from the Kubernetes Pod name via the downward API).
 *   2. `HOSTNAME` — Kubernetes sets it to the Pod name by default.
 *   3. The ECS task id derived from `ECS_CONTAINER_METADATA_URI_V4`.
 *   4. A random UUID.
 *
 * The value must be stable for the life of the process (it identifies which
 * replica holds a slot) but need not survive a restart: a restarted replica
 * re-registers and takes a slot again.
 */
export function resolveInstanceId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Cache the process-wide answer. The random-UUID fallback would otherwise
  // produce a *different* id on every call, and this function is called per
  // WebSocket handshake (buildAgentWsHeaders) — every reconnect would then look
  // like a brand-new replica to the server, inflating the live-instance count
  // and letting a single process consume several slots.
  //
  // Only the default (process.env) lookup is cached; an explicit env argument
  // is a test-only path and must stay side-effect free.
  if (env === process.env) {
    if (cachedInstanceId === null) {
      cachedInstanceId = resolveUncached(env)
    }
    return cachedInstanceId
  }
  return resolveUncached(env)
}

/** Process-wide memo for the default resolution (see resolveInstanceId). */
let cachedInstanceId: string | null = null

/** @internal テスト用: キャッシュを破棄する */
export function resetInstanceIdCacheForTest(): void {
  cachedInstanceId = null
}

function resolveUncached(env: NodeJS.ProcessEnv): string {
  return (
    sanitize(env[ENV_VARS.INSTANCE_ID]) ??
    sanitize(env.HOSTNAME) ??
    sanitize(ecsTaskIdFromMetadataUri(env.ECS_CONTAINER_METADATA_URI_V4)) ??
    crypto.randomUUID()
  )
}
