import { execSync, spawn } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

import { getDockerfilePath, getDockerContextDir } from './dockerfile-path'
import { AGENT_VERSION } from '../constants'
import { getConfigDir, loadConfig } from '../config-manager'
import { t } from '../i18n'
import { logger } from '../logger'

const IMAGE_NAME = 'ai-support-agent'
const PASSTHROUGH_ENV_VARS = [
  'AI_SUPPORT_AGENT_TOKEN',
  'AI_SUPPORT_AGENT_API_URL',
  'AI_SUPPORT_AGENT_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
]

export interface DockerRunOptions {
  token?: string
  apiUrl?: string
  pollInterval?: number
  heartbeatInterval?: number
  verbose?: boolean
  autoUpdate?: boolean
  updateChannel?: string
}

export function checkDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function imageExists(version: string): boolean {
  try {
    execSync(`docker image inspect ${IMAGE_NAME}:${version}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function buildImage(version: string): void {
  const dockerfilePath = getDockerfilePath()
  const contextDir = getDockerContextDir()
  logger.info(t('docker.building'))
  execSync(
    `docker build -t ${IMAGE_NAME}:${version} --build-arg AGENT_VERSION=${version} -f ${dockerfilePath} ${contextDir}`,
    { stdio: 'inherit' },
  )
  logger.success(t('docker.buildComplete'))
}

export function buildVolumeMounts(): string[] {
  const home = os.homedir()
  const mounts: string[] = []

  // Claude Code OAuth tokens and config
  const claudeDir = path.join(home, '.claude')
  if (fs.existsSync(claudeDir)) {
    mounts.push('-v', `${claudeDir}:${claudeDir}:rw`)
  }
  const claudeJson = path.join(home, '.claude.json')
  if (fs.existsSync(claudeJson)) {
    mounts.push('-v', `${claudeJson}:${claudeJson}:rw`)
  }

  // Agent config (resolves custom AI_SUPPORT_AGENT_CONFIG_DIR)
  const agentConfigDir = getConfigDir()
  if (fs.existsSync(agentConfigDir)) {
    mounts.push('-v', `${agentConfigDir}:${agentConfigDir}:rw`)
  }

  // AWS credentials
  const awsDir = path.join(home, '.aws')
  if (fs.existsSync(awsDir)) {
    mounts.push('-v', `${awsDir}:${awsDir}:ro`)
  }

  // Custom project directories from config
  const config = loadConfig()
  if (config?.projects) {
    const mounted = new Set<string>()
    for (const project of config.projects) {
      if (project.projectDir && !mounted.has(project.projectDir) && fs.existsSync(project.projectDir)) {
        mounts.push('-v', `${project.projectDir}:${project.projectDir}:rw`)
        mounted.add(project.projectDir)
      }
    }
  }

  return mounts
}

export function buildEnvArgs(): string[] {
  const args: string[] = []

  // HOME must be passed so volume mounts resolve to the same paths
  args.push('-e', `HOME=${os.homedir()}`)

  for (const key of PASSTHROUGH_ENV_VARS) {
    if (process.env[key]) {
      // Resolve CONFIG_DIR to absolute path so it matches the volume mount inside the container
      if (key === 'AI_SUPPORT_AGENT_CONFIG_DIR') {
        args.push('-e', `${key}=${getConfigDir()}`)
      } else {
        args.push('-e', `${key}=${process.env[key]}`)
      }
    }
  }

  return args
}

export function buildContainerArgs(opts: DockerRunOptions): string[] {
  const args: string[] = ['start']

  if (opts.token) {
    args.push('--token', opts.token)
  }
  if (opts.apiUrl) {
    args.push('--api-url', opts.apiUrl)
  }
  if (opts.pollInterval !== undefined) {
    args.push('--poll-interval', String(opts.pollInterval))
  }
  if (opts.heartbeatInterval !== undefined) {
    args.push('--heartbeat-interval', String(opts.heartbeatInterval))
  }
  if (opts.verbose) {
    args.push('--verbose')
  }
  if (opts.autoUpdate === false) {
    args.push('--no-auto-update')
  }
  if (opts.updateChannel) {
    args.push('--update-channel', opts.updateChannel)
  }

  return args
}

export function runInDocker(opts: DockerRunOptions): void {
  if (!checkDockerAvailable()) {
    logger.error(t('docker.notAvailable'))
    process.exit(1)
    return
  }

  const version = AGENT_VERSION
  if (!imageExists(version)) {
    buildImage(version)
  } else {
    logger.info(t('docker.imageFound', { version }))
  }

  logger.info(t('docker.starting'))

  const volumeMounts = buildVolumeMounts()
  const envArgs = buildEnvArgs()
  const containerArgs = buildContainerArgs(opts)

  const dockerArgs = [
    'run', '--rm', '-it',
    ...volumeMounts,
    ...envArgs,
    `${IMAGE_NAME}:${version}`,
    ...containerArgs,
  ]

  const child = spawn('docker', dockerArgs, {
    stdio: 'inherit',
  })

  // Forward signals to container
  const forwardSignal = (signal: NodeJS.Signals): void => {
    child.kill(signal)
  }
  process.on('SIGINT', () => forwardSignal('SIGINT'))
  process.on('SIGTERM', () => forwardSignal('SIGTERM'))

  child.on('error', (err) => {
    logger.error(t('docker.runFailed', { message: err.message }))
    process.exit(1)
  })

  child.on('close', (code) => {
    process.exit(code ?? 0)
  })
}
