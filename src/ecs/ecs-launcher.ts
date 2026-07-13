/**
 * Launcher-side handlers for the `ecs_launch` / `ecs_stop` commands.
 *
 * A resident agent with local AWS credentials acts as the "launcher": it
 * receives `ecs_launch` via the normal dispatch path (AppSync) and starts a
 * oneshot ECS task with RunTask, injecting the per-run environment
 * (COMMAND_ID, oneshot token, ...) through containerOverrides.
 *
 * SECURITY: the containerEnv/sidecarEnv payloads may contain
 * AGENT_ONESHOT_TOKEN and, for Tailscale-enabled task definitions, the
 * Tailscale authkey. Their values must never be logged — only log resource
 * identifiers.
 */

import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs'
import type { ContainerOverride } from '@aws-sdk/client-ecs'

import { regionFromArn } from './aws-arn'
import { ECS_AGENT_CONTAINER_NAME, TAILSCALE_SIDECAR_CONTAINER_NAME } from '../constants'
import { logger } from '../logger'
import { type CommandResult, errorResult, successResult } from '../types'
import { getErrorMessage } from '../utils'

interface ValidatedLaunchPayload {
  taskDefinitionArn: string
  clusterArn: string
  subnetIds: string[]
  securityGroupIds: string[]
  assignPublicIp: boolean
  containerEnv: Record<string, string>
  /**
   * Env vars (e.g. `TAILSCALE_AUTHKEY_ENV_VAR`) applied via containerOverrides
   * to the `tailscale` sidecar container specifically — never merged into
   * the main container's `containerEnv`. Absent for task definitions that
   * were not registered with `enableTailscale` (see
   * `task-definition-registrar.ts`).
   */
  sidecarEnv?: Record<string, string>
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (!value.every((v) => typeof v === 'string' && v.length > 0)) return null
  return value as string[]
}

/** Validate an optional `Record<string, string>`-shaped env map payload field. `label` names it in error messages. */
function parseOptionalStringRecord(value: unknown, label: string): Record<string, string> | string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return `${label} (object) must not be an array`
  if (typeof value !== 'object' || value === null) return `${label} (object) is required for ecs_launch`
  const parsed: Record<string, string> = {}
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue !== 'string') {
      return `${label}.${key} must be a string`
    }
    parsed[key] = entryValue
  }
  return parsed
}

function validateLaunchPayload(p: Record<string, unknown>): ValidatedLaunchPayload | string {
  const taskDefinitionArn = typeof p.taskDefinitionArn === 'string' && p.taskDefinitionArn ? p.taskDefinitionArn : null
  if (!taskDefinitionArn) return 'taskDefinitionArn is required for ecs_launch'
  const clusterArn = typeof p.clusterArn === 'string' && p.clusterArn ? p.clusterArn : null
  if (!clusterArn) return 'clusterArn is required for ecs_launch'
  const subnetIds = parseStringArray(p.subnetIds)
  if (!subnetIds) return 'subnetIds (non-empty string array) is required for ecs_launch'
  const securityGroupIds = parseStringArray(p.securityGroupIds)
  if (!securityGroupIds) return 'securityGroupIds (non-empty string array) is required for ecs_launch'

  const rawEnv = p.containerEnv
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    return 'containerEnv (object) is required for ecs_launch'
  }
  const containerEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(rawEnv as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      return `containerEnv.${key} must be a string`
    }
    containerEnv[key] = value
  }

  const sidecarEnvResult = parseOptionalStringRecord(p.sidecarEnv, 'sidecarEnv')
  if (typeof sidecarEnvResult === 'string') return sidecarEnvResult

  return {
    taskDefinitionArn,
    clusterArn,
    subnetIds,
    securityGroupIds,
    assignPublicIp: p.assignPublicIp === true,
    containerEnv,
    ...(sidecarEnvResult && { sidecarEnv: sidecarEnvResult }),
  }
}

/**
 * Handle the `ecs_launch` command: RunTask (FARGATE, awsvpc) with the
 * payload's containerEnv injected via containerOverrides.
 * Returns `{ taskArn }` on success, or a failed result carrying RunTask
 * `failures` details so the API can mark the work command/task as failed.
 */
export async function ecsLaunch(p: Record<string, unknown>): Promise<CommandResult> {
  const validated = validateLaunchPayload(p)
  if (typeof validated === 'string') {
    return errorResult(validated)
  }

  const region = regionFromArn(validated.clusterArn)
  if (!region) {
    return errorResult(`Could not determine region from clusterArn: ${validated.clusterArn}`)
  }

  // Do NOT log containerEnv/sidecarEnv — they carry AGENT_ONESHOT_TOKEN and
  // (for Tailscale-enabled task definitions) the Tailscale authkey.
  logger.info(`[ecs] RunTask: taskDefinition=${validated.taskDefinitionArn} cluster=${validated.clusterArn}`)

  try {
    const client = new ECSClient({ region })
    const containerOverrides: ContainerOverride[] = [
      {
        name: ECS_AGENT_CONTAINER_NAME,
        environment: Object.entries(validated.containerEnv).map(([name, value]) => ({ name, value })),
      },
    ]
    if (validated.sidecarEnv) {
      containerOverrides.push({
        name: TAILSCALE_SIDECAR_CONTAINER_NAME,
        environment: Object.entries(validated.sidecarEnv).map(([name, value]) => ({ name, value })),
      })
    }

    const response = await client.send(new RunTaskCommand({
      cluster: validated.clusterArn,
      taskDefinition: validated.taskDefinitionArn,
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: validated.subnetIds,
          securityGroups: validated.securityGroupIds,
          assignPublicIp: validated.assignPublicIp ? 'ENABLED' : 'DISABLED',
        },
      },
      overrides: {
        containerOverrides,
      },
    }))

    if (response.failures && response.failures.length > 0) {
      const reasons = response.failures
        .map((f) => `${f.reason ?? 'unknown'}${f.detail ? ` (${f.detail})` : ''}`)
        .join('; ')
      logger.error(`[ecs] RunTask failed: ${reasons}`)
      return errorResult(`ECS RunTask failed: ${reasons}`, { failures: response.failures })
    }

    const taskArn = response.tasks?.[0]?.taskArn
    if (!taskArn) {
      return errorResult('ECS RunTask returned no task')
    }
    logger.success(`[ecs] Task started: ${taskArn}`)
    return successResult({ taskArn })
  } catch (error) {
    const message = getErrorMessage(error)
    logger.error(`[ecs] RunTask error: ${message}`)
    return errorResult(`ECS RunTask error: ${message}`)
  }
}

/**
 * Handle the `ecs_stop` command: best-effort StopTask (used by the API's
 * timeout sweep to reclaim timed-out oneshot containers).
 */
export async function ecsStop(p: Record<string, unknown>): Promise<CommandResult> {
  const clusterArn = typeof p.clusterArn === 'string' && p.clusterArn ? p.clusterArn : null
  if (!clusterArn) return errorResult('clusterArn is required for ecs_stop')
  const taskArn = typeof p.taskArn === 'string' && p.taskArn ? p.taskArn : null
  if (!taskArn) return errorResult('taskArn is required for ecs_stop')

  const region = regionFromArn(clusterArn)
  if (!region) {
    return errorResult(`Could not determine region from clusterArn: ${clusterArn}`)
  }

  logger.info(`[ecs] StopTask: ${taskArn}`)
  try {
    const client = new ECSClient({ region })
    const response = await client.send(new StopTaskCommand({
      cluster: clusterArn,
      task: taskArn,
      reason: 'Stopped by ai-support-agent launcher (timeout or cancel)',
    }))
    return successResult({
      stopped: true,
      taskArn,
      lastStatus: response.task?.lastStatus,
    })
  } catch (error) {
    const message = getErrorMessage(error)
    logger.warn(`[ecs] StopTask failed (best-effort): ${message}`)
    return errorResult(`ECS StopTask failed: ${message}`, { stopped: false, taskArn })
  }
}
