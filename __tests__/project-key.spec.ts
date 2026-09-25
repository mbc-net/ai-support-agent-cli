import { detectInstallCollisions } from '../src/cli/service/wrapper-helpers'
import { projectKey } from '../src/project-key'

import type { ProjectRegistration } from '../src/types'

const project = (tenantCode: string, projectCode: string) =>
  ({ tenantCode, projectCode }) as ProjectRegistration

describe('projectKey', () => {
  it('joins tenantCode and projectCode with a slash', () => {
    expect(projectKey(project('mbc', 'MBC_01'))).toBe('mbc/MBC_01')
  })

  it('distinguishes the same projectCode across tenants', () => {
    expect(projectKey(project('mbc', 'P'))).not.toBe(projectKey(project('jcci', 'P')))
  })
})

/**
 * `detectInstallCollisions` keys its maps by `projectKey`, and the three
 * service installers look entries up with a key they build for the same
 * project. If the two ever diverge, `collisions.get(...)` misses and **every
 * colliding project installs silently**, overwriting each other's unit file —
 * no error, no log. Pin the agreement here rather than relying on three
 * separate installers happening to build the same string.
 */
describe('detectInstallCollisions のキー', () => {
  it('projectKey() で引ける形で names / collisions を返す', () => {
    const a = project('mbc', 'MBC_01')
    const b = project('mbc', 'MBC-01')

    const { names, collisions } = detectInstallCollisions(
      [a, b],
      (tenantCode, projectCode) =>
        `agent-${tenantCode}-${projectCode.toLowerCase().replace(/_/g, '-')}`,
    )

    // 両者は同じユニット名へ丸まるので衝突として報告される。
    expect(names.get(projectKey(a))).toBe(names.get(projectKey(b)))
    expect(collisions.get(projectKey(a))).toBeDefined()
    expect(collisions.get(projectKey(b))).toBeDefined()
  })

  it('衝突しないプロジェクトも projectKey() で names を引ける', () => {
    const a = project('mbc', 'MBC_01')
    const b = project('jcci', 'JCCI_01')

    const { names, collisions } = detectInstallCollisions(
      [a, b],
      (tenantCode, projectCode) => `agent-${tenantCode}-${projectCode}`,
    )

    expect(names.get(projectKey(a))).toBe('agent-mbc-MBC_01')
    expect(names.get(projectKey(b))).toBe('agent-jcci-JCCI_01')
    expect(collisions.size).toBe(0)
  })
})
