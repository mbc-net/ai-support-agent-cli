import { buildDockerRunWithLogRotate } from '../../../src/cli/service/service-template-helpers'

/**
 * ensureDir (used by darwin/linux/win32-service.ts for both plain and
 * owner-only-mode directories) lives in ../../../src/utils and is covered by
 * __tests__/utils.spec.ts — no need to duplicate that coverage here.
 */
describe('buildDockerRunWithLogRotate', () => {
  const buildDockerRun = (outputRedirect: string) =>
    `docker run --rm -i --name "test-container" \\\n  -e FOO=bar \\${outputRedirect}`

  describe('without logDir (no log rotation)', () => {
    it('returns the docker run line followed by EXIT_CODE capture', () => {
      const result = buildDockerRunWithLogRotate({
        buildDockerRun,
        logDir: undefined,
        supervisorLabel: 'systemd',
      })

      expect(result).toContain('docker run --rm -i --name "test-container"')
      expect(result).toContain('EXIT_CODE=$?')
      // No FIFO setup
      expect(result).not.toContain('_ROT_DIR=')
      expect(result).not.toContain('mkfifo')
      expect(result).not.toContain('log-rotate')
    })

    it('calls buildDockerRun with an empty output redirect', () => {
      const mock = jest.fn().mockReturnValue('docker run ...')
      buildDockerRunWithLogRotate({
        buildDockerRun: mock,
        logDir: undefined,
        supervisorLabel: 'launchd',
      })
      expect(mock).toHaveBeenCalledWith('')
    })
  })

  describe('with logDir (FIFO-based log rotation)', () => {
    const logDir = '/tmp/logs/mbc-mbc01'

    it('sets up named FIFOs and log-rotate subprocesses', () => {
      const result = buildDockerRunWithLogRotate({
        buildDockerRun,
        logDir,
        supervisorLabel: 'systemd',
      })

      expect(result).toContain('_ROT_DIR=$(mktemp -d -t ai-support-agent-rot.XXXXXX)')
      expect(result).toContain("mkfifo \"$_ROT_DIR/out\" \"$_ROT_DIR/err\"")
      expect(result).toContain('ai-support-agent log-rotate --no-tee')
      expect(result).toContain('agent.out.log')
      expect(result).toContain('agent.err.log')
      expect(result).toContain('_ROT_OUT_PID=$!')
      expect(result).toContain('_ROT_ERR_PID=$!')
    })

    it('redirects docker output to the FIFOs', () => {
      const result = buildDockerRunWithLogRotate({
        buildDockerRun,
        logDir,
        supervisorLabel: 'systemd',
      })

      expect(result).toContain('> "$_ROT_DIR/out" 2> "$_ROT_DIR/err"')
    })

    it('waits for rotators to drain before exiting', () => {
      const result = buildDockerRunWithLogRotate({
        buildDockerRun,
        logDir,
        supervisorLabel: 'systemd',
      })

      expect(result).toContain('wait "$_ROT_OUT_PID" "$_ROT_ERR_PID" 2>/dev/null || true')
    })

    it('captures EXIT_CODE from docker (not the rotator)', () => {
      const result = buildDockerRunWithLogRotate({
        buildDockerRun,
        logDir,
        supervisorLabel: 'systemd',
      })

      expect(result).toContain('EXIT_CODE=$?')
      // The EXIT_CODE comment should clarify it is docker's exit status
      expect(result).toContain("EXIT_CODE is purely docker's exit status")
    })

    it('includes a trap to clean up the temp FIFO directory', () => {
      const result = buildDockerRunWithLogRotate({
        buildDockerRun,
        logDir,
        supervisorLabel: 'launchd',
      })

      expect(result).toContain('trap \'rm -rf "$_ROT_DIR" 2>/dev/null || true\' EXIT')
    })

    it('shell-quotes log paths containing spaces', () => {
      const spacedLogDir = '/home/jane doe/logs'
      const result = buildDockerRunWithLogRotate({
        buildDockerRun,
        logDir: spacedLogDir,
        supervisorLabel: 'systemd',
      })

      // shellQuote wraps in single-quotes when the path contains a space
      expect(result).toContain("'/home/jane doe/logs/agent.out.log'")
      expect(result).toContain("'/home/jane doe/logs/agent.err.log'")
    })

    it('mentions the correct supervisor label in the comment', () => {
      const systemdResult = buildDockerRunWithLogRotate({
        buildDockerRun,
        logDir,
        supervisorLabel: 'systemd',
      })
      expect(systemdResult).toContain('systemd')
      expect(systemdResult).not.toContain('launchd')

      const launchdResult = buildDockerRunWithLogRotate({
        buildDockerRun,
        logDir,
        supervisorLabel: 'launchd',
      })
      expect(launchdResult).toContain('launchd')
    })

    it('calls buildDockerRun with the FIFO redirect fragment', () => {
      const mock = jest.fn().mockReturnValue('docker run ...')
      buildDockerRunWithLogRotate({
        buildDockerRun: mock,
        logDir,
        supervisorLabel: 'systemd',
      })
      expect(mock).toHaveBeenCalledWith(expect.stringContaining('$_ROT_DIR/out'))
    })
  })
})
