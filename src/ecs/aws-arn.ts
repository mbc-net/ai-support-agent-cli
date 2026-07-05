/**
 * Small AWS ARN / ECR URI parsing helpers used by the ECS agent feature.
 *
 * The region for each AWS SDK client is derived deterministically from the
 * resource the caller is operating on (ECR repository URI or ECS cluster ARN)
 * instead of relying on ambient AWS_REGION configuration.
 */

/**
 * Extract the region from an AWS ARN.
 * Example: arn:aws:ecs:ap-northeast-1:123456789012:cluster/my-cluster -> ap-northeast-1
 * Returns null when the string is not a valid ARN or has no region part.
 */
export function regionFromArn(arn: string): string | null {
  const parts = arn.split(':')
  if (parts.length < 6 || parts[0] !== 'arn') return null
  return parts[3] || null
}

export interface EcrRepositoryUriParts {
  /** Registry host, e.g. 123456789012.dkr.ecr.ap-northeast-1.amazonaws.com */
  registry: string
  /** AWS account id of the registry */
  accountId: string
  /** Region parsed from the registry host */
  region: string
  /** Repository name (path after the registry host) */
  repositoryName: string
}

/**
 * Parse an ECR repository URI of the form
 * `{accountId}.dkr.ecr.{region}.amazonaws.com/{repositoryName}`.
 * Returns null when the URI does not look like an ECR repository URI.
 */
export function parseEcrRepositoryUri(uri: string): EcrRepositoryUriParts | null {
  const match = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?\/([a-z0-9][a-z0-9._/-]*)$/.exec(uri)
  if (!match) return null
  const [, accountId, region, repositoryName] = match
  const registry = uri.slice(0, uri.indexOf('/'))
  return { registry, accountId, region, repositoryName }
}
