import { filterEnvVarsOverride } from '../src/env-vars-filter'

jest.mock('../src/logger', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}))

const ctx = { prefix: '[test]' }

describe('filterEnvVarsOverride', () => {
  describe('basics', () => {
    it('returns empty when input is undefined', () => {
      expect(filterEnvVarsOverride(undefined, ctx)).toEqual({})
    })

    it('returns empty when input is empty', () => {
      expect(filterEnvVarsOverride({}, ctx)).toEqual({})
    })

    it('passes through valid env vars', () => {
      const result = filterEnvVarsOverride(
        {
          ANTHROPIC_API_KEY: 'sk-test',
          ANTHROPIC_MODEL: 'claude-sonnet-4-6',
          GIT_AUTHOR_NAME: 'Bot',
        },
        ctx,
      )
      expect(result).toEqual({
        ANTHROPIC_API_KEY: 'sk-test',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
        GIT_AUTHOR_NAME: 'Bot',
      })
    })
  })

  describe('value validation', () => {
    it('skips non-string values', () => {
      const result = filterEnvVarsOverride(
        {
          OK: 'value',
          NULLY: null as unknown as string,
          NUMERIC: 42 as unknown as string,
          BOOLY: true as unknown as string,
          OBJECTY: {} as unknown as string,
        },
        ctx,
      )
      expect(result).toEqual({ OK: 'value' })
    })

    it('skips empty string', () => {
      const result = filterEnvVarsOverride(
        { OK: 'value', EMPTY: '' },
        ctx,
      )
      expect(result).toEqual({ OK: 'value' })
    })
  })

  describe('name format validation', () => {
    it('skips invalid name formats', () => {
      const result = filterEnvVarsOverride(
        {
          GOOD: 'ok',
          'BAD-NAME': 'bad',
          '1STARTS_WITH_DIGIT': 'bad',
          'WITH#HASH': 'bad',
          lower_case: 'bad',
          MixedCase: 'bad',
        },
        ctx,
      )
      expect(result).toEqual({ GOOD: 'ok' })
    })
  })

  describe('denylist (exact)', () => {
    const denylistedExact = [
      'PATH', 'HOME', 'USER', 'SHELL', 'LOGNAME',
      'TMPDIR', 'TEMP', 'TMP',
      'LD_PRELOAD', 'LD_LIBRARY_PATH',
      'GCONV_PATH', 'HOSTALIASES', 'NLSPATH', 'LOCPATH', 'RES_OPTIONS',
      'BASH_ENV', 'ENV', 'IFS', 'PROMPT_COMMAND', 'SHELLOPTS', 'BASHOPTS',
      'NODE_OPTIONS', 'NODE_PATH',
      'PYTHONPATH', 'PYTHONSTARTUP',
      'PERL5LIB', 'PERL5OPT', 'PERL5DB',
      'RUBYOPT', 'RUBYLIB',
      'LUA_PATH', 'LUA_CPATH',
      'PLAYWRIGHT_BROWSERS_PATH',
      'ZDOTDIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'CODEX_HOME',
      'CLAUDECODE',
      'CODEX_SANDBOX_MODE', 'KUBERNETES_SERVICE_HOST',
    ]

    it.each(denylistedExact)('rejects %s', (name) => {
      const result = filterEnvVarsOverride({ [name]: 'value' }, ctx)
      expect(result[name]).toBeUndefined()
    })
  })

  describe('denylist (prefix)', () => {
    it('rejects LD_ prefix (LD_AUDIT/LD_DEBUG etc.)', () => {
      const result = filterEnvVarsOverride(
        {
          LD_AUDIT: '/tmp/evil.so',
          LD_BIND_NOW: '1',
          LD_DEBUG: 'all',
          LD_PROFILE: 'evil',
        },
        ctx,
      )
      expect(result).toEqual({})
    })

    it('rejects DYLD_ prefix (macOS)', () => {
      const result = filterEnvVarsOverride(
        { DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' },
        ctx,
      )
      expect(result).toEqual({})
    })

    it('rejects AI_SUPPORT_ prefix (tenant impersonation)', () => {
      const result = filterEnvVarsOverride(
        {
          AI_SUPPORT_TENANT_CODE: 'spoofed',
          AI_SUPPORT_PROJECT_CODE: 'spoofed',
        },
        ctx,
      )
      expect(result).toEqual({})
    })

    it('rejects BASH_FUNC_ prefix (Shellshock)', () => {
      const result = filterEnvVarsOverride(
        { BASH_FUNC_foo: '() { :; }; evil' },
        ctx,
      )
      expect(result).toEqual({})
    })

    it('does NOT reject keys starting with _AI_SUPPORT_ (prefix match is literal)', () => {
      const result = filterEnvVarsOverride(
        { _AI_SUPPORT_X: 'allowed' },
        ctx,
      )
      expect(result).toEqual({ _AI_SUPPORT_X: 'allowed' })
    })
  })

  describe('CLAUDE_CODE_*', () => {
    it('allows CLAUDE_CODE_OAUTH_TOKEN (legitimate auth env from api mapping)', () => {
      // api 側 AgentEnvVarsService は CLAUDE_CODE#OAUTH_TOKEN を
      // CLAUDE_CODE_OAUTH_TOKEN にマップして送る。これを弾くと OAuth 認証が
      // 壊れるため、agent 側ではこのキーのみ allowlist する。
      const result = filterEnvVarsOverride(
        { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value' },
        ctx,
      )
      expect(result).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token-value' })
    })

    it('rejects other CLAUDE_CODE_* keys (SSE_PORT etc.) but allows OAUTH_TOKEN', () => {
      const result = filterEnvVarsOverride(
        {
          CLAUDE_CODE_SSE_PORT: '12345',
          CLAUDE_CODE_OAUTH_TOKEN: 'oauth-ok',
          CLAUDE_CODE_FOO: 'whatever',
        },
        ctx,
      )
      expect(result).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oauth-ok' })
    })
  })

  describe('agent sandbox anchors (defense in depth with api)', () => {
    it('rejects ZDOTDIR even when ENV# regex would allow it', () => {
      // ZDOTDIR は agent の PTY sandbox の zsh rc 探索アンカー。
      // ここを上書きされると cd 制限 sandbox が外れるため必ず弾く。
      const result = filterEnvVarsOverride({ ZDOTDIR: '/tmp/evil' }, ctx)
      expect(result).toEqual({})
    })

    it('rejects XDG_DATA_HOME and XDG_CONFIG_HOME (code-server sandbox)', () => {
      const result = filterEnvVarsOverride(
        {
          XDG_DATA_HOME: '/tmp/evil-data',
          XDG_CONFIG_HOME: '/tmp/evil-config',
        },
        ctx,
      )
      expect(result).toEqual({})
    })

    it('rejects CODEX_HOME (Codex CLI の config.toml / MCP 設定アンカー)', () => {
      // 任意ディレクトリを指されると攻撃者が用意した config.toml を
      // Codex に読ませられる（writable_roots / network_access / mcp_servers）。
      const result = filterEnvVarsOverride({ CODEX_HOME: '/tmp/evil-codex' }, ctx)
      expect(result).toEqual({})
    })
  })

  describe('CLI サンドボックス判定の覆し (defense in depth with api)', () => {
    it('rejects CODEX_SANDBOX_MODE (danger-full-access の仕込みを防ぐ)', () => {
      // resolveCodexSandboxMode は「明示指定」を環境由来の既定より優先する。
      // Web 設定から danger-full-access を仕込まれると、コンテナ境界のない
      // ホスト上でも Codex のサンドボックスが外れる。
      const result = filterEnvVarsOverride(
        { CODEX_SANDBOX_MODE: 'danger-full-access' },
        ctx,
      )
      expect(result).toEqual({})
    })

    it('rejects KUBERNETES_SERVICE_HOST (コンテナ内判定アンカー)', () => {
      // isRunningOnKubernetes が「コンテナの中か」を判定するアンカー。
      // サンドボックス既定値と自動更新の抑止判定の双方に効く。
      const result = filterEnvVarsOverride(
        { KUBERNETES_SERVICE_HOST: '10.43.0.1' },
        ctx,
      )
      expect(result).toEqual({})
    })

    it('does NOT reject near-miss names (完全一致のみを弾く)', () => {
      const nearMisses = {
        CODEX_HOMES: '/workspace/codex-homes',
        MY_CODEX_HOME: '/workspace/mine',
        CODEX_SANDBOX_MODES: 'read-only',
        CODEX_SANDBOX: 'read-only',
        KUBERNETES_SERVICE_HOSTNAME: 'kubernetes.default',
        KUBERNETES_SERVICE_PORT: '443',
      }
      expect(filterEnvVarsOverride({ ...nearMisses }, ctx)).toEqual(nearMisses)
    })
  })
})
