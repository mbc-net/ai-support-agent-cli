/**
 * Failing tests (red phase) for the terminal idle-session grace timeout fix.
 *
 * Bug: leaving a terminal open in production loses the session (PTY) because
 * the agent-side grace window (SESSION_GRACE_TIMEOUT_MS) of 5 minutes is too
 * short.
 *
 * Confirmed fix (NOT implemented yet — these tests must be RED):
 *   1. SESSION_GRACE_TIMEOUT_MS default: 300_000 (5 min) → 3_600_000 (60 min).
 *   2. The env var AI_SUPPORT_AGENT_TERMINAL_GRACE_MS (milliseconds, positive
 *      integer) overrides the default. It is resolved at module load via an
 *      IIFE, following the CONFIG_DIR pattern in src/constants.ts, and
 *      ENV_VARS gains TERMINAL_GRACE_MS: 'AI_SUPPORT_AGENT_TERMINAL_GRACE_MS'.
 *   3. Invalid values (non-numeric, zero, negative) are ignored and the
 *      60-minute default is used.
 *
 * Env switching uses the jest.resetModules() + re-require pattern from
 * __tests__/config-dir-env.spec.ts so the module-level IIFE re-evaluates.
 */

const ENV_NAME = 'AI_SUPPORT_AGENT_TERMINAL_GRACE_MS'

describe('SESSION_GRACE_TIMEOUT_MS with AI_SUPPORT_AGENT_TERMINAL_GRACE_MS env', () => {
  const originalEnv = process.env[ENV_NAME]
  let stderrSpy: jest.SpyInstance

  beforeEach(() => {
    // Clear module cache so src/terminal/constants.ts re-evaluates its IIFE
    // against the env state prepared by each test.
    jest.resetModules()
    // Invalid env values emit a warning via process.stderr.write at module
    // load. Spy (and silence) it so tests can assert on the warning without
    // polluting the test output.
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    // Restore env
    if (originalEnv === undefined) {
      delete process.env[ENV_NAME]
    } else {
      process.env[ENV_NAME] = originalEnv
    }
    jest.resetModules()
  })

  it('should default to 3_600_000 (60 minutes) when env is not set', () => {
    delete process.env[ENV_NAME]
    const { SESSION_GRACE_TIMEOUT_MS } = require('../../src/terminal/constants')
    expect(SESSION_GRACE_TIMEOUT_MS).toBe(3_600_000)
  })

  it('should use the env value when set to a positive integer (120000)', () => {
    process.env[ENV_NAME] = '120000'
    const { SESSION_GRACE_TIMEOUT_MS } = require('../../src/terminal/constants')
    expect(SESSION_GRACE_TIMEOUT_MS).toBe(120000)
  })

  it.each(['abc', '-1', '0'])(
    'should ignore the invalid env value %p and use the 60-minute default',
    (value) => {
      process.env[ENV_NAME] = value
      const { SESSION_GRACE_TIMEOUT_MS } = require('../../src/terminal/constants')
      expect(SESSION_GRACE_TIMEOUT_MS).toBe(3_600_000)
    },
  )

  it.each(['60s', '1e6', '1_200_000'])(
    'should reject the non-pure-integer value %p (parseInt would mis-parse it) and use the default',
    (value) => {
      process.env[ENV_NAME] = value
      const { SESSION_GRACE_TIMEOUT_MS } = require('../../src/terminal/constants')
      expect(SESSION_GRACE_TIMEOUT_MS).toBe(3_600_000)
    },
  )

  it.each(['abc', '-1', '0', '60s', '1e6', '1_200_000'])(
    'should warn to stderr when the env is set to the invalid value %p',
    (value) => {
      process.env[ENV_NAME] = value
      require('../../src/terminal/constants')
      expect(stderrSpy).toHaveBeenCalledTimes(1)
      const message = String(stderrSpy.mock.calls[0][0])
      expect(message).toContain(ENV_NAME)
      expect(message).toContain(`"${value}"`)
      expect(message).toContain('3600000')
    },
  )

  it('should NOT warn when the env is set to a valid positive integer', () => {
    process.env[ENV_NAME] = '120000'
    const { SESSION_GRACE_TIMEOUT_MS } = require('../../src/terminal/constants')
    expect(SESSION_GRACE_TIMEOUT_MS).toBe(120000)
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('should NOT warn when the env is not set', () => {
    delete process.env[ENV_NAME]
    const { SESSION_GRACE_TIMEOUT_MS } = require('../../src/terminal/constants')
    expect(SESSION_GRACE_TIMEOUT_MS).toBe(3_600_000)
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it('should define ENV_VARS.TERMINAL_GRACE_MS as the env var name', () => {
    const { ENV_VARS } = require('../../src/constants')
    expect(ENV_VARS.TERMINAL_GRACE_MS).toBe('AI_SUPPORT_AGENT_TERMINAL_GRACE_MS')
  })
})
