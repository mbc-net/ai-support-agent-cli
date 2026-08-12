import {
  resetInstanceIdCacheForTest,
  resolveInstanceId,
} from '../src/replica-identity'

describe('resolveInstanceId', () => {
  beforeEach(() => {
    resetInstanceIdCacheForTest()
  })

  it('プロセス内では同じ値を返す（再接続のたびに別レプリカ扱いされない）', () => {
    // buildAgentWsHeaders は WS ハンドシェイクのたびに呼ばれる。ランダム
    // フォールバックが毎回異なる値を返すと、再接続が新規レプリカに見えて
    // 稼働数が水増しされ、1プロセスが複数の枠を消費してしまう。
    const original = { ...process.env }
    delete process.env.AI_SUPPORT_AGENT_INSTANCE_ID
    delete process.env.HOSTNAME
    delete process.env.ECS_CONTAINER_METADATA_URI_V4
    try {
      const first = resolveInstanceId()
      const second = resolveInstanceId()
      expect(second).toBe(first)
    } finally {
      process.env = original
    }
  })

  it('prefers the explicit AI_SUPPORT_AGENT_INSTANCE_ID override', () => {
    expect(
      resolveInstanceId({
        AI_SUPPORT_AGENT_INSTANCE_ID: 'explicit-id',
        HOSTNAME: 'pod-name',
        ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/task-abc',
      } as NodeJS.ProcessEnv),
    ).toBe('explicit-id')
  })

  it('falls back to HOSTNAME (the Pod name in Kubernetes)', () => {
    expect(
      resolveInstanceId({
        HOSTNAME: 'ai-support-agent-7d9f8-abcde',
      } as NodeJS.ProcessEnv),
    ).toBe('ai-support-agent-7d9f8-abcde')
  })

  it('derives the ECS task id from the container metadata URI', () => {
    expect(
      resolveInstanceId({
        ECS_CONTAINER_METADATA_URI_V4:
          'http://169.254.170.2/v4/9f8c7b6a5d4e3f2a1b0c',
      } as NodeJS.ProcessEnv),
    ).toBe('9f8c7b6a5d4e3f2a1b0c')
  })

  it('generates a random id when nothing identifies the replica', () => {
    const first = resolveInstanceId({} as NodeJS.ProcessEnv)
    const second = resolveInstanceId({} as NodeJS.ProcessEnv)

    expect(first).toMatch(/^[A-Za-z0-9._-]{1,128}$/)
    expect(first).not.toBe(second)
  })

  it('replaces characters that would break the server-side sort key', () => {
    // `#` is the sort-key separator; leaving it in would let an instance id
    // forge extra key segments.
    expect(
      resolveInstanceId({ HOSTNAME: 'pod#with#hash' } as NodeJS.ProcessEnv),
    ).toBe('pod-with-hash')
  })

  it('truncates to the 128-character server limit', () => {
    const long = 'a'.repeat(200)
    expect(
      resolveInstanceId({ HOSTNAME: long } as NodeJS.ProcessEnv),
    ).toHaveLength(128)
  })

  it('ignores a candidate that has no alphanumeric content', () => {
    const resolved = resolveInstanceId({
      AI_SUPPORT_AGENT_INSTANCE_ID: '---',
      HOSTNAME: 'real-host',
    } as NodeJS.ProcessEnv)

    expect(resolved).toBe('real-host')
  })

  it('ignores empty and whitespace-only candidates', () => {
    expect(
      resolveInstanceId({
        AI_SUPPORT_AGENT_INSTANCE_ID: '   ',
        HOSTNAME: 'real-host',
      } as NodeJS.ProcessEnv),
    ).toBe('real-host')
  })

  it('does not collapse two distinct hostnames into the same id', () => {
    const a = resolveInstanceId({ HOSTNAME: 'pod#a' } as NodeJS.ProcessEnv)
    const b = resolveInstanceId({ HOSTNAME: 'pod#b' } as NodeJS.ProcessEnv)

    expect(a).not.toBe(b)
  })
})
