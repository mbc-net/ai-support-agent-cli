import {
  type AgentExecutionContext,
  forwardAgentExecutionContext,
} from '../src/commands/agent-execution-context'

/**
 * `executeCommand` resolves the execution context once and hands it to the chat
 * and E2E executors, which hand it on again. Every field is optional, so a
 * dropped hand-off line used to compile cleanly and the command just ran without
 * that part of its context. These tests pin the two things that cannot be seen
 * from a call site: that the copy is complete, and that an override wins even
 * when its value is `undefined`.
 */
describe('forwardAgentExecutionContext', () => {
  /**
   * Every key of AgentExecutionContext, each with a value distinguishable from
   * the others. Declared `satisfies` so adding a field to the interface without
   * adding it here is a type error — the fixture cannot silently fall behind.
   */
  const FULL_CONTEXT = {
    serverConfig: { chatMode: 'agent' },
    activeChatMode: 'claude_code',
    availableChatModes: ['claude_code', 'codex'],
    agentId: 'agent-1',
    projectDir: '/work/project',
    projectConfig: { project: { projectCode: 'MBC_01' } },
    mcpConfigPath: '/tmp/mcp.json',
    tenantCode: 'mbc',
    browserLocalPort: 19222,
  } as unknown as Required<AgentExecutionContext>

  const CONTEXT_KEYS = Object.keys(FULL_CONTEXT) as (keyof AgentExecutionContext)[]

  it('コンテキストの全フィールドをそのまま引き渡す', () => {
    const forwarded = forwardAgentExecutionContext(FULL_CONTEXT)

    // toEqual だけだと「増えた分を運べていない」を見逃すのでキー集合も突き合わせる
    expect(Object.keys(forwarded).sort()).toEqual([...CONTEXT_KEYS].sort())
    for (const key of CONTEXT_KEYS) {
      expect(forwarded[key]).toBe(FULL_CONTEXT[key])
    }
  })

  it('コンテキスト以外のプロパティは運ばない', () => {
    const forwarded = forwardAgentExecutionContext({
      ...FULL_CONTEXT,
      // executeCommand だけが読む値。ハンドラへ渡してはならない。
      activeChatModeExplicit: true,
      onReboot: jest.fn(),
    } as AgentExecutionContext)

    expect(forwarded).not.toHaveProperty('activeChatModeExplicit')
    expect(forwarded).not.toHaveProperty('onReboot')
  })

  it('overrides は同名フィールドに勝つ', () => {
    const forwarded = forwardAgentExecutionContext(FULL_CONTEXT, {
      activeChatMode: 'codex',
    })

    expect(forwarded.activeChatMode).toBe('codex')
    // 上書きしなかったフィールドは元のまま
    expect(forwarded.agentId).toBe('agent-1')
  })

  /**
   * executeCommand はコマンド種別ごとにモードを解決し直す。解決できなかった
   * ときは「未解決」を渡さねばならず、エージェント全体のモードへ戻ってはいけない。
   */
  it('overrides が undefined でもその値で上書きする（元の値へ戻さない）', () => {
    const forwarded = forwardAgentExecutionContext(FULL_CONTEXT, {
      activeChatMode: undefined,
    })

    expect(forwarded.activeChatMode).toBeUndefined()
    expect('activeChatMode' in forwarded).toBe(true)
  })

  it('overrides 省略時は元のコンテキストと同値になる', () => {
    expect(forwardAgentExecutionContext(FULL_CONTEXT, {})).toEqual(
      forwardAgentExecutionContext(FULL_CONTEXT),
    )
  })

  it('空のコンテキストでも全キーを undefined で揃える', () => {
    const forwarded = forwardAgentExecutionContext({})

    expect(Object.keys(forwarded).sort()).toEqual([...CONTEXT_KEYS].sort())
    for (const key of CONTEXT_KEYS) {
      expect(forwarded[key]).toBeUndefined()
    }
  })
})
