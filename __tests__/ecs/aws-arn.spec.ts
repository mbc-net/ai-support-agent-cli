/**
 * Tests for src/ecs/aws-arn.ts
 */

import { parseEcrRepositoryUri, regionFromArn } from '../../src/ecs/aws-arn'

describe('regionFromArn', () => {
  it('extracts the region from an ECS cluster ARN', () => {
    expect(regionFromArn('arn:aws:ecs:ap-northeast-1:123456789012:cluster/my-cluster'))
      .toBe('ap-northeast-1')
  })

  it('extracts the region from a task definition ARN', () => {
    expect(regionFromArn('arn:aws:ecs:us-east-1:123456789012:task-definition/family:3'))
      .toBe('us-east-1')
  })

  it('returns null for a non-ARN string', () => {
    expect(regionFromArn('not-an-arn')).toBeNull()
    expect(regionFromArn('')).toBeNull()
  })

  it('returns null when the string has enough parts but is not an ARN', () => {
    expect(regionFromArn('foo:bar:baz:region:acct:res')).toBeNull()
  })

  it('returns null when the region part is empty', () => {
    expect(regionFromArn('arn:aws:iam::123456789012:role/my-role')).toBeNull()
  })
})

describe('parseEcrRepositoryUri', () => {
  it('parses a standard ECR repository URI', () => {
    const parts = parseEcrRepositoryUri('123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/my-repo')
    expect(parts).toEqual({
      registry: '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com',
      accountId: '123456789012',
      region: 'ap-northeast-1',
      repositoryName: 'my-repo',
    })
  })

  it('parses a namespaced repository name', () => {
    const parts = parseEcrRepositoryUri('123456789012.dkr.ecr.us-west-2.amazonaws.com/team/app-image')
    expect(parts?.repositoryName).toBe('team/app-image')
    expect(parts?.region).toBe('us-west-2')
  })

  it('parses a China-partition registry host', () => {
    const parts = parseEcrRepositoryUri('123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/my-repo')
    expect(parts?.registry).toBe('123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn')
    expect(parts?.repositoryName).toBe('my-repo')
  })

  it('returns null for a non-ECR URI', () => {
    expect(parseEcrRepositoryUri('docker.io/library/nginx')).toBeNull()
    expect(parseEcrRepositoryUri('my-repo')).toBeNull()
    expect(parseEcrRepositoryUri('')).toBeNull()
  })

  it('returns null when the account id is not 12 digits', () => {
    expect(parseEcrRepositoryUri('12345.dkr.ecr.ap-northeast-1.amazonaws.com/my-repo')).toBeNull()
  })

  it('returns null when the repository name is missing', () => {
    expect(parseEcrRepositoryUri('123456789012.dkr.ecr.ap-northeast-1.amazonaws.com')).toBeNull()
    expect(parseEcrRepositoryUri('123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/')).toBeNull()
  })
})
