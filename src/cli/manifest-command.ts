/**
 * `manifest` CLI commands.
 *
 * Generate a Kubernetes Deployment or an ECS task/service definition that runs
 * the agent as N replicas from a single registered agent token.
 *
 * Registering an agent per replica is not workable in a container platform
 * (replicas come and go on every rollout), so one token backs one *logical*
 * agent and the replicas are distinguished by their instance id. The plan's
 * replica limit is validated here, before anything is written, rather than
 * being discovered at runtime when the extra replicas sit in standby.
 */


import { Command } from 'commander'

import { ApiClient } from '../api-client'
import { getProjectList, loadConfig } from '../config-manager'
import { logger } from '../logger'
import { atomicWriteFile } from '../utils'
import {
  assertReplicasWithinLimit,
  generateEcsManifest,
  generateK8sManifest,
} from '../manifest/manifest-generator'
import { getErrorMessage } from '../utils'
import { resolveTargetProject } from './ecs-publish-command'

export interface ManifestCliOptions {
  replicas?: string
  image?: string
  name?: string
  project?: string
  out?: string
  /** Skip the server-side replica-limit check (offline manifest generation). */
  skipLimitCheck?: boolean
}

export interface K8sManifestCliOptions extends ManifestCliOptions {
  namespace?: string
}

export interface EcsManifestCliOptions extends ManifestCliOptions {
  cluster: string
  subnets: string[]
  securityGroups: string[]
  logGroup?: string
  executionRole?: string
  taskRole?: string
  region?: string
  cpu?: string
  memory?: string
  assignPublicIp?: boolean
}

function parseReplicas(value: string | undefined): number {
  if (value === undefined) return 1
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--replicas must be a positive integer: ${value}`)
  }
  return parsed
}

/**
 * Resolve the project to generate for and check the requested replica count
 * against the tenant's plan limit.
 *
 * The limit lookup is a network call; `--skip-limit-check` exists for
 * generating manifests offline (CI, air-gapped docs). Skipping only removes
 * the *early* error — the server still enforces the limit at runtime, so an
 * over-provisioned Deployment simply leaves the extra replicas in standby.
 */
async function resolveTargetAndValidate(
  opts: ManifestCliOptions,
): Promise<{
  tenantCode: string
  projectCode: string
  token: string
  apiUrl: string
  replicas: number
}> {
  const config = loadConfig()
  if (!config) {
    throw new Error(
      'No agent configuration found. Run "ai-support-agent login" first.',
    )
  }
  const project = resolveTargetProject(getProjectList(config), opts.project)
  const replicas = parseReplicas(opts.replicas)

  if (!opts.skipLimitCheck) {
    const client = new ApiClient(project.apiUrl, project.token)
    const { maxReplicas } = await client.getReplicaLimit()
    assertReplicasWithinLimit(replicas, maxReplicas)
    logger.info(
      `Replica limit for ${project.tenantCode}: ${maxReplicas === null ? 'unlimited' : maxReplicas} (requested ${replicas})`,
    )
  }

  return {
    tenantCode: project.tenantCode,
    projectCode: project.projectCode,
    token: project.token,
    apiUrl: project.apiUrl,
    replicas,
  }
}

/**
 * Write to `--out` when given, otherwise print to stdout.
 *
 * Manifests embed the agent token, so a file is created with owner-only
 * permissions (0600) — the default 0644 would expose the token to every local
 * user on a shared build host.
 */
function emit(content: string, outPath: string | undefined, label: string): void {
  if (!outPath) {
    process.stdout.write(content)
    return
  }
  // Write via a freshly created 0600 temp file and rename into place.
  // Writing directly would leave a window where an existing 0644 manifest
  // already holds the token but still has its old, world-readable permissions
  // (writeFileSync's `mode` only applies when it creates the file).
  atomicWriteFile(outPath, content, 0o600)
  logger.success(`${label} written to ${outPath} (mode 0600)`)
}

export async function runK8sManifest(
  opts: K8sManifestCliOptions,
): Promise<void> {
  const target = await resolveTargetAndValidate(opts)
  const manifest = generateK8sManifest({
    ...target,
    namespace: opts.namespace,
    image: opts.image,
    name: opts.name,
  })
  emit(manifest, opts.out, 'Kubernetes manifest')
  if (!opts.out) return
  logger.warn(
    'The manifest contains the agent token. Treat it as a secret: do not commit it to a repository.',
  )
}

export async function runEcsManifest(
  opts: EcsManifestCliOptions,
): Promise<void> {
  const target = await resolveTargetAndValidate(opts)
  const { taskDefinition, service } = generateEcsManifest({
    ...target,
    cluster: opts.cluster,
    subnets: opts.subnets,
    securityGroups: opts.securityGroups,
    logGroup: opts.logGroup,
    executionRoleArn: opts.executionRole,
    taskRoleArn: opts.taskRole,
    region: opts.region,
    cpu: opts.cpu,
    memory: opts.memory,
    assignPublicIp: opts.assignPublicIp,
    image: opts.image,
    name: opts.name,
  })

  if (opts.out) {
    emit(taskDefinition, `${opts.out}.taskdef.json`, 'ECS task definition')
    emit(service, `${opts.out}.service.json`, 'ECS service definition')
  } else {
    process.stdout.write('# --- task definition ---\n')
    process.stdout.write(`${taskDefinition}\n`)
    process.stdout.write('# --- service definition ---\n')
    process.stdout.write(`${service}\n`)
  }
  logger.warn(
    'Store the agent token in Secrets Manager and replace REPLACE_WITH_SECRET_ARN in the task definition before registering it.',
  )
}

export function registerManifestCommands(program: Command): void {
  const manifest = program
    .command('manifest')
    .description(
      'Generate deployment manifests that run this agent as multiple replicas',
    )

  manifest
    .command('k8s')
    .description('Generate a Kubernetes Secret + Deployment')
    .option('--replicas <n>', 'Number of replicas (default: 1)')
    .option('--namespace <name>', 'Kubernetes namespace (default: default)')
    .option('--image <image>', 'Container image')
    .option('--name <name>', 'Resource name (default: ai-support-agent)')
    .option('--project <tenantCode/projectCode>', 'Target project')
    .option('--out <path>', 'Write to a file instead of stdout')
    .option('--skip-limit-check', 'Do not query the plan replica limit')
    .action(async (opts: K8sManifestCliOptions) => {
      try {
        await runK8sManifest(opts)
      } catch (error) {
        logger.error(`[manifest] k8s failed: ${getErrorMessage(error)}`)
        process.exitCode = 1
      }
    })

  manifest
    .command('ecs')
    .description('Generate an ECS task definition + service definition')
    .requiredOption('--cluster <name>', 'ECS cluster name')
    .requiredOption('--subnets <ids...>', 'Subnet ids for awsvpc networking')
    .requiredOption('--security-groups <ids...>', 'Security group ids')
    .option('--replicas <n>', 'Desired task count (default: 1)')
    .option('--image <image>', 'Container image')
    .option('--name <name>', 'Task family / service name')
    .option('--region <region>', 'AWS region for the awslogs driver')
    .option('--cpu <n>', 'Task CPU units (default: 1024)')
    .option('--memory <n>', 'Task memory in MiB (default: 2048)')
    .option('--log-group <name>', 'CloudWatch Logs group')
    .option('--execution-role <arn>', 'Task execution role ARN')
    .option('--task-role <arn>', 'Task role ARN')
    .option('--assign-public-ip', 'Assign a public IP to the tasks')
    .option('--project <tenantCode/projectCode>', 'Target project')
    .option('--out <prefix>', 'Write <prefix>.taskdef.json / <prefix>.service.json')
    .option('--skip-limit-check', 'Do not query the plan replica limit')
    .action(async (opts: EcsManifestCliOptions) => {
      try {
        await runEcsManifest(opts)
      } catch (error) {
        logger.error(`[manifest] ecs failed: ${getErrorMessage(error)}`)
        process.exitCode = 1
      }
    })
}
