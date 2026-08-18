import { isRunningOnKubernetes } from '../../src/utils/container-runtime'

/**
 * Kubernetes 判定は self-update-capability（自動更新の抑止）と codex-runner
 * （サンドボックスモードの決定）の両方が使う。片方だけ更新されて食い違うことが
 * ないよう、判定はこのヘルパーに一本化されている。
 */
describe('isRunningOnKubernetes', () => {
  it('returns true when KUBERNETES_SERVICE_HOST is set', () => {
    expect(isRunningOnKubernetes({ KUBERNETES_SERVICE_HOST: '10.43.0.1' })).toBe(true)
  })

  it('returns false when KUBERNETES_SERVICE_HOST is unset', () => {
    expect(isRunningOnKubernetes({})).toBe(false)
  })

  it('returns false when KUBERNETES_SERVICE_HOST is an empty string', () => {
    expect(isRunningOnKubernetes({ KUBERNETES_SERVICE_HOST: '' })).toBe(false)
  })

  it('ignores unrelated container environment variables', () => {
    expect(isRunningOnKubernetes({ AI_SUPPORT_AGENT_IN_DOCKER: '1' })).toBe(false)
  })

  it('falls back to the current process env when no argument is given', () => {
    const original = process.env.KUBERNETES_SERVICE_HOST
    try {
      process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1'
      expect(isRunningOnKubernetes()).toBe(true)

      delete process.env.KUBERNETES_SERVICE_HOST
      expect(isRunningOnKubernetes()).toBe(false)
    } finally {
      if (original === undefined) delete process.env.KUBERNETES_SERVICE_HOST
      else process.env.KUBERNETES_SERVICE_HOST = original
    }
  })
})
