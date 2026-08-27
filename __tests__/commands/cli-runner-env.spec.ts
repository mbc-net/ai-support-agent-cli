import { applyEnvVarsOverride, applyPolicyContextEnv, type PolicyContext } from '../../src/commands/cli-runner-env'

describe('cli-runner-env', () => {
  describe('applyPolicyContextEnv', () => {
    it('leaves env untouched when policyContext is undefined', () => {
      const env: Record<string, string> = { EXISTING: 'value' }
      applyPolicyContextEnv(env, undefined)
      expect(env).toEqual({ EXISTING: 'value' })
    })

    it('writes all fields when fully populated', () => {
      const env: Record<string, string> = {}
      const policyContext: PolicyContext = {
        tenantCode: 'mbc',
        projectCode: 'MBC_01',
        conversationId: 'conv-1',
        browserSessionId: 'sess-1',
        browserLocalPort: 4123,
        e2eExecutionId: 'exec-1',
        e2eTestCaseId: 'tc-1',
        taskId: 'task-1',
      }
      applyPolicyContextEnv(env, policyContext)
      expect(env).toEqual({
        AI_SUPPORT_TENANT_CODE: 'mbc',
        AI_SUPPORT_PROJECT_CODE: 'MBC_01',
        AI_SUPPORT_CONVERSATION_ID: 'conv-1',
        AI_SUPPORT_BROWSER_SESSION_ID: 'sess-1',
        AI_SUPPORT_BROWSER_LOCAL_PORT: '4123',
        AI_SUPPORT_E2E_EXECUTION_ID: 'exec-1',
        AI_SUPPORT_E2E_TEST_CASE_ID: 'tc-1',
        AI_SUPPORT_TASK_ID: 'task-1',
      })
    })

    it('omits fields that are absent from a partial policyContext', () => {
      const env: Record<string, string> = {}
      applyPolicyContextEnv(env, { tenantCode: 'mbc' })
      expect(env).toEqual({ AI_SUPPORT_TENANT_CODE: 'mbc' })
    })
  })

  describe('applyEnvVarsOverride', () => {
    it('leaves env untouched when envVarsOverride is undefined', () => {
      const env: Record<string, string> = { EXISTING: 'value' }
      applyEnvVarsOverride(env, undefined)
      expect(env).toEqual({ EXISTING: 'value' })
    })

    it('copies string entries and overwrites existing keys', () => {
      const env: Record<string, string> = { FOO: 'old' }
      applyEnvVarsOverride(env, { FOO: 'new', BAR: 'baz' })
      expect(env).toEqual({ FOO: 'new', BAR: 'baz' })
    })

    // ------------------------------------------------------------------
    // chat 実行経路も agent 側 denylist（env-vars-filter）を通す（A3）
    //
    // 従来 applyEnvVarsOverride は名前検証も denylist も無く env へ書き込んで
    // いたため、terminal / vscode 経路にだけ効いていた防御を chat 経路が
    // 素通りしていた。
    // ------------------------------------------------------------------
    it.each([
      ['PATH', '/attacker/bin'],
      ['LD_PRELOAD', '/attacker/evil.so'],
      ['NODE_OPTIONS', '--require /attacker/evil.js'],
      ['ZDOTDIR', '/attacker/zdotdir'],
      ['CODEX_HOME', '/attacker/codex'],
      ['CODEX_SANDBOX_MODE', 'danger-full-access'],
      ['KUBERNETES_SERVICE_HOST', '10.0.0.1'],
      ['AI_SUPPORT_TENANT_CODE', 'other-tenant'],
      ['BASH_FUNC_x%%', '() { id; }'],
      ['DYLD_INSERT_LIBRARIES', '/attacker/evil.dylib'],
      ['PLAYWRIGHT_BROWSERS_PATH', '/attacker/browsers'],
    ])('does not apply denylisted env %s', (key, value) => {
      const env: Record<string, string> = {}
      applyEnvVarsOverride(env, { [key]: value, SAFE: 'ok' })
      expect(env).toEqual({ SAFE: 'ok' })
    })

    it('does not let a denylisted key overwrite an existing env value', () => {
      const env: Record<string, string> = { PATH: '/usr/bin' }
      applyEnvVarsOverride(env, { PATH: '/attacker/bin' })
      expect(env.PATH).toBe('/usr/bin')
    })

    it('skips env names that do not match the API-side name pattern', () => {
      const env: Record<string, string> = {}
      applyEnvVarsOverride(env, { 'lower_case': 'x', '1LEADING_DIGIT': 'x', 'HAS-DASH': 'x', OK_NAME: 'ok' })
      expect(env).toEqual({ OK_NAME: 'ok' })
    })

    // 回帰対策: CLAUDE_CODE_OAUTH_TOKEN は api 側が CLAUDE_CODE#OAUTH_TOKEN を
    // 正規にマップして送ってくる env 名そのもの。これを弾くと OAuth 認証経路が壊れる。
    it('still applies CLAUDE_CODE_OAUTH_TOKEN (OAuth path must keep working)', () => {
      const env: Record<string, string> = {}
      applyEnvVarsOverride(env, { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' })
      expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-xxx' })
    })

    it('rejects other CLAUDE_CODE_* keys', () => {
      const env: Record<string, string> = {}
      applyEnvVarsOverride(env, { CLAUDE_CODE_SSE_PORT: '1234' })
      expect(env).toEqual({})
    })

    it('skips empty-string and non-string values', () => {
      const env: Record<string, string> = {}
      applyEnvVarsOverride(env, {
        EMPTY: '',
        NULLISH: null as unknown as string,
        NUMERIC: 42 as unknown as string,
        VALID: 'ok',
      })
      expect(env).toEqual({ VALID: 'ok' })
    })
  })
})
