/**
 * ecs_launch capability detection.
 *
 * A resident agent should only advertise the `ecs_launch` capability when it
 * can actually perform ECS RunTask/StopTask — i.e. when AWS credentials are
 * resolvable through the default provider chain (env vars, shared
 * config/credentials files, SSO cache, IMDS/ECS metadata, ...). Advertising
 * it unconditionally would let the API's automatic launcher selection pick an
 * agent that cannot launch anything, making ECS dispatch fail unpredictably.
 *
 * Override (checked before detection):
 *   AI_SUPPORT_AGENT_ECS_LAUNCHER=true   force-enable, skip detection
 *   AI_SUPPORT_AGENT_ECS_LAUNCHER=false  force-disable, skip detection
 *
 * The detection result is cached for the process lifetime so the register
 * retry loop does not re-probe the credential chain (IMDS/STS) on every
 * attempt.
 */

import { fromNodeProviderChain } from '@aws-sdk/credential-providers'

import { ECS_LAUNCHER_DETECT_TIMEOUT_MS, ENV_VARS } from '../constants'
import { logger } from '../logger'
import { getErrorMessage } from '../utils'

// Only a POSITIVE detection is cached for the process lifetime. A negative
// result (e.g. a transient 3s IMDS timeout during cold start) must NOT be
// sticky, or credentials that become available later would never be picked
// up. Re-detection on subsequent register attempts is safe because the
// register loop is backoff-based, so this cannot spam STS/IMDS.
let credentialsConfirmed = false

/** Reset the positive-detection cache (tests only). */
export function resetEcsLauncherCapabilityCache(): void {
  credentialsConfirmed = false
}

async function credentialsResolvable(timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`credential resolution timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      timer.unref?.()
    })
    const credentials = await Promise.race([fromNodeProviderChain()(), timeout])
    // Never log the credential values — only whether resolution succeeded.
    return Boolean(credentials?.accessKeyId)
  } catch (error) {
    logger.info(`[ecs] AWS credentials not resolvable: ${getErrorMessage(error)}`)
    return false
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Decide whether this agent should advertise the `ecs_launch` capability.
 * Returns true when credentials are resolvable or force-enabled via env.
 */
export async function detectEcsLauncherCapability(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs: number = ECS_LAUNCHER_DETECT_TIMEOUT_MS,
): Promise<boolean> {
  const override = env[ENV_VARS.ECS_LAUNCHER]
  if (override === 'false') {
    logger.info(`[ecs] ecs_launch capability disabled (${ENV_VARS.ECS_LAUNCHER}=false)`)
    return false
  }
  if (override === 'true') {
    logger.info(`[ecs] ecs_launch capability force-enabled (${ENV_VARS.ECS_LAUNCHER}=true, credential detection skipped)`)
    return true
  }

  // A confirmed positive is sticky; a previous negative falls through to a
  // fresh probe on the next call.
  if (credentialsConfirmed) {
    return true
  }

  const resolved = await credentialsResolvable(timeoutMs)
  if (resolved) {
    credentialsConfirmed = true
    logger.info('[ecs] AWS credentials resolved; advertising ecs_launch capability')
  } else {
    logger.info('[ecs] ecs_launch capability not advertised (no resolvable AWS credentials; will re-check on next registration)')
  }
  return resolved
}
