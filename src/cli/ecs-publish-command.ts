/**
 * `ecs publish` CLI command.
 *
 * Publishes an ECS execution agent (launcher-agent architecture):
 *   1. Build (or reuse) the image, push it to ECR, resolve its digest
 *      — all with the LOCAL AWS credentials (the API never calls AWS).
 *   2. Register a Fargate task definition pinned to that digest
 *      (awslogs driver, NO environment variables in the definition).
 *   3. Register the agent with the API
 *      (POST /api/:tenantCode/agent/ecs-agents, agent Bearer token).
 *
 * The agentId (`ecs-{uuid}`) is generated on first publish and persisted in
 * the project config keyed by the ECR repository URI, so a re-publish
 * (image update) overwrites the same agent with a new task definition
 * revision instead of creating a new one.
 */

import * as crypto from 'crypto'

import { Command } from 'commander'

import { ApiClient } from '../api-client'
import { addProject, getProjectList, loadConfig } from '../config-manager'
import {
  DEFAULT_ECS_CPU,
  DEFAULT_ECS_LOG_GROUP,
  DEFAULT_ECS_MEMORY,
  ECS_AGENT_ID_PREFIX,
  ECS_TASK_FAMILY_PREFIX,
  SERVER_SETUP_CUSTOM_TASKS_CAPABILITY,
} from '../constants'
import { publishImage } from '../ecs/ecr-publisher'
import { regionFromArn, parseEcrRepositoryUri } from '../ecs/aws-arn'
import { registerTaskDefinition } from '../ecs/task-definition-registrar'
import { t } from '../i18n'
import { logger } from '../logger'
import type { ProjectRegistration } from '../types'
import { getErrorMessage, nowIso } from '../utils'

export interface EcsPublishCliOptions {
  repositoryUri: string
  tag: string
  cluster: string
  subnets: string[]
  securityGroups: string[]
  dockerfile?: string
  image?: string
  cpu?: string
  memory?: string
  name?: string
  assignPublicIp?: boolean
  logGroup?: string
  executionRole?: string
  taskRole?: string
  launcherAgentId?: string
  project?: string
  /**
   * ECS container isolation (opt-in — omitting all three registers the exact
   * same task definition as before). Intended for server-setup execution
   * agents so a compromised custom Ansible task cannot persist to the
   * container's root filesystem, run as root, or retain Linux capabilities.
   */
  readonlyRootfs?: boolean
  runAsUser?: string
  dropCapabilities?: string[]
}

/**
 * Parse `--run-as-user` into the ECS `user` field. Accepts a bare uid, a
 * `uid:gid`, or a plain username — passed through to ECS verbatim after a light
 * shape check (letters/digits/underscore/hyphen, optionally a single `:`).
 */
export function parseRunAsUser(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed || !/^[A-Za-z0-9_-]+(:[A-Za-z0-9_-]+)?$/.test(trimmed)) {
    throw new Error(`--run-as-user must be a uid, uid:gid, or username: ${value}`)
  }
  return trimmed
}

/**
 * Resolve the target project registration.
 * `--project tenantCode/projectCode` selects one; when omitted the single
 * registered project is used (ambiguity is an error, no fallback).
 */
export function resolveTargetProject(
  projects: ProjectRegistration[],
  projectFlag?: string,
): ProjectRegistration {
  if (projects.length === 0) {
    throw new Error('No project is registered. Run "ai-support-agent login" first.')
  }
  if (!projectFlag) {
    if (projects.length === 1) return projects[0]
    const available = projects.map((p) => `${p.tenantCode}/${p.projectCode}`).join(', ')
    throw new Error(`Multiple projects are registered. Specify one with --project <tenantCode/projectCode>. Available: ${available}`)
  }
  const slashIdx = projectFlag.indexOf('/')
  if (slashIdx < 0) {
    throw new Error(`--project must be in "tenantCode/projectCode" format: ${projectFlag}`)
  }
  const tenantCode = projectFlag.substring(0, slashIdx)
  const projectCode = projectFlag.substring(slashIdx + 1)
  const project = projects.find((p) => p.tenantCode === tenantCode && p.projectCode === projectCode)
  if (!project) {
    throw new Error(`Project not found: ${projectFlag}`)
  }
  return project
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${label} must be a positive integer: ${value}`)
  }
  return parsed
}

/**
 * Orchestrate the full publish flow. Throws on failure; the commander action
 * wrapper converts failures into a non-zero exit code.
 */
export async function runEcsPublish(opts: EcsPublishCliOptions): Promise<void> {
  const config = loadConfig()
  if (!config) {
    throw new Error('No agent configuration found. Run "ai-support-agent login" first.')
  }
  const project = resolveTargetProject(getProjectList(config), opts.project)

  const region = regionFromArn(opts.cluster)
  if (!region) {
    throw new Error(`Invalid cluster ARN (region could not be determined): ${opts.cluster}`)
  }
  const repoParts = parseEcrRepositoryUri(opts.repositoryUri)
  if (!repoParts) {
    throw new Error(`Invalid ECR repository URI: ${opts.repositoryUri}`)
  }
  const cpu = parsePositiveInt(opts.cpu, DEFAULT_ECS_CPU, 'cpu')
  const memory = parsePositiveInt(opts.memory, DEFAULT_ECS_MEMORY, 'memory')
  const runAsUser = parseRunAsUser(opts.runAsUser)

  // Reuse the persisted agentId on re-publish (same ECR repository URI).
  const existingAgentId = project.ecsAgents?.[opts.repositoryUri]
  const agentId = existingAgentId ?? `${ECS_AGENT_ID_PREFIX}-${crypto.randomUUID()}`
  if (existingAgentId) {
    logger.info(`[ecs] Re-publishing existing ECS agent: ${agentId}`)
  } else {
    logger.info(`[ecs] Publishing new ECS agent: ${agentId}`)
  }

  // 1. Build / push the image and resolve its digest
  const image = await publishImage({
    repositoryUri: opts.repositoryUri,
    tag: opts.tag,
    dockerfile: opts.dockerfile,
    image: opts.image,
  })

  // 2. Register the task definition (digest pin, awslogs, no env vars)
  const family = `${ECS_TASK_FAMILY_PREFIX}-${project.tenantCode}-${agentId}`
  const logGroupName = opts.logGroup ?? DEFAULT_ECS_LOG_GROUP
  const taskDefinition = await registerTaskDefinition({
    family,
    imageUri: image.imageUri,
    cpu,
    memory,
    region,
    logGroupName,
    executionRoleArn: opts.executionRole,
    taskRoleArn: opts.taskRole,
    ...(opts.readonlyRootfs && { readonlyRootFilesystem: true }),
    ...(runAsUser !== undefined && { user: runAsUser }),
    ...(opts.dropCapabilities && opts.dropCapabilities.length > 0 && {
      dropCapabilities: opts.dropCapabilities,
    }),
  })

  // 3. Register the agent with the API (Bearer = agent token)
  const client = new ApiClient(project.apiUrl, project.token)
  client.setTenantCode(project.tenantCode)
  client.setProjectCode(project.projectCode)
  await client.registerEcsAgent({
    agentId,
    displayName: opts.name ?? `${repoParts.repositoryName}:${opts.tag}`,
    // ECS execution agents can run server-setup recipe bodies (custom Ansible
    // tasks) in the strict `ecs` guard mode; advertise the capability so the
    // api will dispatch body-carrying recipes to this agent.
    capabilities: [SERVER_SETUP_CUSTOM_TASKS_CAPABILITY],
    ecsConfig: {
      imageUri: image.imageUri,
      imageTag: image.imageTag,
      imageDigest: image.imageDigest,
      cpu,
      memory,
      taskDefinitionArn: taskDefinition.taskDefinitionArn,
      taskDefinitionFamily: taskDefinition.family,
      clusterArn: opts.cluster,
      subnetIds: opts.subnets,
      securityGroupIds: opts.securityGroups,
      ...(opts.assignPublicIp !== undefined && { assignPublicIp: opts.assignPublicIp }),
      logGroupName,
      ...(opts.launcherAgentId && { launcherAgentId: opts.launcherAgentId }),
      registeredBy: config.agentId,
      registeredAt: nowIso(),
    },
  })

  // Persist the agentId so a re-publish reuses it.
  addProject({
    ...project,
    ecsAgents: { ...project.ecsAgents, [opts.repositoryUri]: agentId },
  })

  logger.success(`[ecs] ECS agent published: agentId=${agentId} taskDefinition=${taskDefinition.taskDefinitionArn}`)
}

export function registerEcsCommands(program: Command): void {
  const ecs = program.command('ecs').description(t('cmd.ecs'))

  ecs
    .command('publish')
    .description(t('cmd.ecsPublish'))
    .requiredOption('--repository-uri <uri>', t('cmd.ecsPublish.repositoryUri'))
    .requiredOption('--tag <tag>', t('cmd.ecsPublish.tag'))
    .requiredOption('--cluster <clusterArn>', t('cmd.ecsPublish.cluster'))
    .requiredOption('--subnets <ids...>', t('cmd.ecsPublish.subnets'))
    .requiredOption('--security-groups <ids...>', t('cmd.ecsPublish.securityGroups'))
    .option('--dockerfile <path>', t('cmd.ecsPublish.dockerfile'))
    .option('--image <name>', t('cmd.ecsPublish.image'))
    .option('--cpu <n>', t('cmd.ecsPublish.cpu'))
    .option('--memory <n>', t('cmd.ecsPublish.memory'))
    .option('--name <name>', t('cmd.ecsPublish.name'))
    .option('--assign-public-ip', t('cmd.ecsPublish.assignPublicIp'))
    .option('--log-group <name>', t('cmd.ecsPublish.logGroup'))
    .option('--execution-role <arn>', t('cmd.ecsPublish.executionRole'))
    .option('--task-role <arn>', t('cmd.ecsPublish.taskRole'))
    .option('--launcher-agent-id <id>', t('cmd.ecsPublish.launcherAgentId'))
    .option('--project <tenantCode/projectCode>', t('cmd.ecsPublish.project'))
    // Opt-in ECS container isolation (server-setup hardening). Omitting all
    // three preserves the previous task definition exactly.
    .option('--readonly-rootfs', 'Register the container with a read-only root filesystem (tmpfs volumes for /tmp and the Ansible workspace)')
    .option('--run-as-user <user>', 'Run the container as this non-root uid, uid:gid, or username')
    .option('--drop-capabilities <caps...>', 'Linux capabilities to drop (e.g. ALL)')
    .action(async (opts: EcsPublishCliOptions) => {
      try {
        await runEcsPublish(opts)
      } catch (error) {
        logger.error(`[ecs] publish failed: ${getErrorMessage(error)}`)
        process.exitCode = 1
      }
    })
}
