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
