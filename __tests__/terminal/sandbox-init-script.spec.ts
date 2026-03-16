import { buildSandboxInitScript } from '../../src/terminal/sandbox-init-script'

describe('buildSandboxInitScript', () => {
  it('should return a non-empty script string', () => {
    const script = buildSandboxInitScript('/tmp/project')
    expect(script).toBeTruthy()
    expect(typeof script).toBe('string')
  })

  it('should embed the project directory in __SANDBOX_DIR', () => {
    const script = buildSandboxInitScript('/home/user/my-project')
    expect(script).toContain("__SANDBOX_DIR='/home/user/my-project'")
  })

  it('should escape single quotes in the project directory path', () => {
    const script = buildSandboxInitScript("/home/user/project's dir")
    expect(script).toContain("__SANDBOX_DIR='/home/user/project'\\''s dir'")
  })

  it('should define sandbox functions (cd, pushd, popd, exec)', () => {
    const script = buildSandboxInitScript('/tmp/project')
    expect(script).toContain('cd()')
    expect(script).toContain('pushd()')
    expect(script).toContain('popd()')
    expect(script).toContain('exec()')
  })

  it('should include __sandbox_is_inside helper', () => {
    const script = buildSandboxInitScript('/tmp/project')
    expect(script).toContain('__sandbox_is_inside()')
  })

  it('should include PROMPT_COMMAND for bash', () => {
    const script = buildSandboxInitScript('/tmp/project')
    expect(script).toContain('PROMPT_COMMAND=')
    expect(script).toContain('BASH_VERSION')
  })

  it('should include precmd hook for zsh', () => {
    const script = buildSandboxInitScript('/tmp/project')
    expect(script).toContain('ZSH_VERSION')
    expect(script).toContain('add-zsh-hook precmd')
  })

  it('should include __sandbox_check function', () => {
    const script = buildSandboxInitScript('/tmp/project')
    expect(script).toContain('__sandbox_check()')
  })

  it('should disable exec with an error message', () => {
    const script = buildSandboxInitScript('/tmp/project')
    expect(script).toContain('restricted: exec is disabled in sandbox mode')
  })

  it('should include restricted message for cd', () => {
    const script = buildSandboxInitScript('/tmp/project')
    expect(script).toContain('restricted: cannot leave project directory')
  })
})
