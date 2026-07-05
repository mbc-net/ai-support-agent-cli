/**
 * ECR image publisher for `ecs publish`.
 *
 * Logs in to ECR with the local AWS credentials (GetAuthorizationToken),
 * builds/tags/pushes the image with the docker CLI, and resolves the pushed
 * image digest via DescribeImages so the task definition can pin the image
 * by digest. The registry password is always passed over stdin
 * (`--password-stdin`), never on the command line.
 */

import { spawn } from 'child_process'

import { DescribeImagesCommand, ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr'

import { parseEcrRepositoryUri } from './aws-arn'
import { getDockerPath } from '../docker/docker-utils'
import { logger } from '../logger'
import { toError } from '../utils'

export interface PublishImageOptions {
  /** ECR repository URI (push destination) */
  repositoryUri: string
  /** Image tag to push */
  tag: string
  /** Dockerfile used for the build (docker default when omitted) */
  dockerfile?: string
  /** Pre-built local image to push (skips the build step) */
  image?: string
  /** Build context directory (default: current directory) */
  contextDir?: string
}

export interface PublishedImage {
  /** Digest-pinned image URI (`<repositoryUri>@sha256:...`) */
  imageUri: string
  imageTag: string
  imageDigest: string
}

/**
 * Run a docker CLI command. Output is streamed to the terminal.
 * When `input` is provided it is written to the child's stdin (used for
 * `docker login --password-stdin` so the password never appears in argv).
 */
export function runDocker(args: string[], input?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(getDockerPath(), args, {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
    })
    if (input !== undefined && proc.stdin) {
      // If the child dies between spawn and write (e.g. `docker login` fails
      // instantly), writing to its stdin raises EPIPE. Swallow it here and let
      // the 'close'/'error' handlers report the real exit code instead of
      // surfacing an uncaught EPIPE.
      proc.stdin.on('error', () => { /* handled via close/error below */ })
      proc.stdin.write(input)
      proc.stdin.end()
    }
    proc.on('error', (err) => reject(toError(err)))
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`docker ${args[0]} exited with code ${code}`))
    })
  })
}

/**
 * Log in the local docker CLI to the ECR registry using GetAuthorizationToken.
 * The decoded password is piped to `docker login --password-stdin`.
 */
export async function loginToEcr(client: ECRClient, registry: string): Promise<void> {
  logger.info(`[ecs] Logging in to ECR registry: ${registry}`)
  const response = await client.send(new GetAuthorizationTokenCommand({}))
  const token = response.authorizationData?.[0]?.authorizationToken
  if (!token) {
    throw new Error('ECR GetAuthorizationToken returned no authorization data')
  }
  const decoded = Buffer.from(token, 'base64').toString('utf-8')
  const separator = decoded.indexOf(':')
  if (separator < 0) {
    throw new Error('ECR authorization token has an unexpected format')
  }
  const username = decoded.slice(0, separator)
  const password = decoded.slice(separator + 1)
  await runDocker(['login', '--username', username, '--password-stdin', registry], password)
  logger.success(`[ecs] Logged in to ${registry}`)
}

/**
 * Resolve the digest of a pushed image tag via DescribeImages.
 */
export async function getImageDigest(
  client: ECRClient,
  repositoryName: string,
  tag: string,
): Promise<string> {
  const response = await client.send(new DescribeImagesCommand({
    repositoryName,
    imageIds: [{ imageTag: tag }],
  }))
  const digest = response.imageDetails?.[0]?.imageDigest
  if (!digest) {
    throw new Error(`Could not resolve image digest for ${repositoryName}:${tag}`)
  }
  return digest
}

/**
 * Build (unless a local image is given), tag, and push the image to ECR,
 * then return the digest-pinned image URI.
 */
export async function publishImage(options: PublishImageOptions): Promise<PublishedImage> {
  const parts = parseEcrRepositoryUri(options.repositoryUri)
  if (!parts) {
    throw new Error(`Invalid ECR repository URI: ${options.repositoryUri}`)
  }

  const client = new ECRClient({ region: parts.region })
  await loginToEcr(client, parts.registry)

  const remoteRef = `${options.repositoryUri}:${options.tag}`
  if (options.image) {
    logger.info(`[ecs] Using local image ${options.image} (build skipped)`)
    await runDocker(['tag', options.image, remoteRef])
  } else {
    const contextDir = options.contextDir ?? '.'
    const buildArgs = ['build', '-t', remoteRef]
    if (options.dockerfile) {
      buildArgs.push('-f', options.dockerfile)
    }
    buildArgs.push(contextDir)
    logger.info(`[ecs] Building image ${remoteRef}`)
    await runDocker(buildArgs)
  }

  logger.info(`[ecs] Pushing ${remoteRef}`)
  await runDocker(['push', remoteRef])

  const imageDigest = await getImageDigest(client, parts.repositoryName, options.tag)
  const imageUri = `${options.repositoryUri}@${imageDigest}`
  logger.success(`[ecs] Pushed image: ${imageUri}`)
  return { imageUri, imageTag: options.tag, imageDigest }
}
