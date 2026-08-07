import { CONTAINER_START_ARGV, buildDockerUserArgs } from '../../src/docker/docker-args'
import { CLI_FLAG_NO_DOCKER } from '../../src/constants'

describe('CONTAINER_START_ARGV', () => {
  it('is the in-container CLI start prefix', () => {
    expect(CONTAINER_START_ARGV).toEqual(['ai-support-agent', 'start', CLI_FLAG_NO_DOCKER])
  })

  it('spreads into a fresh mutable array (not a shared reference)', () => {
    const a = [...CONTAINER_START_ARGV, '--project', 'X']
    const b = [...CONTAINER_START_ARGV]
    a.push('mutated')
    expect(b).toEqual(['ai-support-agent', 'start', CLI_FLAG_NO_DOCKER])
    expect(a).toContain('mutated')
  })
})

describe('buildDockerUserArgs', () => {
  const origGetuid = process.getuid
  const origGetgid = process.getgid

  afterEach(() => {
    process.getuid = origGetuid
    process.getgid = origGetgid
  })

  it('returns --user uid:gid when process.getuid is available', () => {
    process.getuid = (() => 1001) as typeof process.getuid
    process.getgid = (() => 2002) as typeof process.getgid
    expect(buildDockerUserArgs()).toEqual(['--user', '1001:2002'])
  })

  it('returns an empty array when process.getuid is undefined (e.g. Windows)', () => {
    // @ts-expect-error simulate a platform without getuid
    process.getuid = undefined
    expect(buildDockerUserArgs()).toEqual([])
  })
})
