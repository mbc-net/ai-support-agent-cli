import { readAgentCredentialEnv } from '../../../src/cli/service/agent-credential-env'
import { ENV_VARS } from '../../../src/constants'

const KEYS = [
  ENV_VARS.ANTHROPIC_API_KEY,
  ENV_VARS.CLAUDE_CODE_OAUTH_TOKEN,
  ENV_VARS.CODEX_API_KEY,
  ENV_VARS.CODEX_ACCESS_TOKEN,
]

describe('readAgentCredentialEnv', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('reads all four credentials from the environment', () => {
    process.env[ENV_VARS.ANTHROPIC_API_KEY] = 'sk-ant'
    process.env[ENV_VARS.CLAUDE_CODE_OAUTH_TOKEN] = 'oat'
    process.env[ENV_VARS.CODEX_API_KEY] = 'codex-key'
    process.env[ENV_VARS.CODEX_ACCESS_TOKEN] = 'codex-token'

    expect(readAgentCredentialEnv()).toEqual({
      anthropicApiKey: 'sk-ant',
      claudeCodeOauthToken: 'oat',
      codexApiKey: 'codex-key',
      codexAccessToken: 'codex-token',
    })
  })

  it('returns undefined for each unset credential', () => {
    expect(readAgentCredentialEnv()).toEqual({
      anthropicApiKey: undefined,
      claudeCodeOauthToken: undefined,
      codexApiKey: undefined,
      codexAccessToken: undefined,
    })
  })

  it('reads each credential independently', () => {
    process.env[ENV_VARS.CODEX_API_KEY] = 'only-codex'
    const result = readAgentCredentialEnv()
    expect(result.codexApiKey).toBe('only-codex')
    expect(result.anthropicApiKey).toBeUndefined()
    expect(result.claudeCodeOauthToken).toBeUndefined()
    expect(result.codexAccessToken).toBeUndefined()
  })
})
