import {
  buildSandboxInitScript,
  isZshShell,
  buildBashRcContent,
  buildZshRcContent,
  buildOpenFolderDisableKeybindings,
} from '../../src/terminal/sandbox-init-script'

describe('isZshShell', () => {
  it('should return true for /bin/zsh', () => {
    expect(isZshShell('/bin/zsh')).toBe(true)
  })

  it('should return true for /usr/bin/zsh5', () => {
    expect(isZshShell('/usr/bin/zsh5')).toBe(true)
  })

  it('should return false for /bin/bash', () => {
    expect(isZshShell('/bin/bash')).toBe(false)
  })

  it('should return false for empty string', () => {
    expect(isZshShell('')).toBe(false)
  })

  it('should use process.env.SHELL when no argument', () => {
    const origShell = process.env.SHELL
    try {
      process.env.SHELL = '/bin/zsh'
      expect(isZshShell()).toBe(true)
      process.env.SHELL = '/bin/bash'
      expect(isZshShell()).toBe(false)
    } finally {
      process.env.SHELL = origShell
    }
  })

  it('should return false when no argument and SHELL is undefined', () => {
    const origShell = process.env.SHELL
    try {
      delete process.env.SHELL
      expect(isZshShell()).toBe(false)
    } finally {
      process.env.SHELL = origShell
    }
  })
})

describe('buildBashRcContent', () => {
  it('should include original .bashrc source', () => {
    const content = buildBashRcContent('# sandbox')
    expect(content).toContain('source ~/.bashrc')
  })

  it('should include the sandbox script', () => {
    const content = buildBashRcContent('__SANDBOX_DIR=test')
    expect(content).toContain('__SANDBOX_DIR=test')
  })
})

describe('buildZshRcContent', () => {
  it('should include original .zshrc source', () => {
    const content = buildZshRcContent('# sandbox')
    expect(content).toContain('.zshrc')
    expect(content).toContain('source')
  })

  it('should include the sandbox script', () => {
    const content = buildZshRcContent('__SANDBOX_DIR=test')
    expect(content).toContain('__SANDBOX_DIR=test')
  })

  it('should fall back to empty string when both ZDOTDIR and HOME are undefined', () => {
    const origZdotdir = process.env.ZDOTDIR
    const origHome = process.env.HOME
    try {
      delete process.env.ZDOTDIR
      delete process.env.HOME
      const content = buildZshRcContent('# sandbox')
      expect(content).toContain("'/.zshrc'")
    } finally {
      if (origZdotdir !== undefined) process.env.ZDOTDIR = origZdotdir
      else delete process.env.ZDOTDIR
      if (origHome !== undefined) process.env.HOME = origHome
      else delete process.env.HOME
    }
  })

  it('should use ZDOTDIR if set', () => {
    const origZdotdir = process.env.ZDOTDIR
    try {
      process.env.ZDOTDIR = '/custom/zdotdir'
      const content = buildZshRcContent('# sandbox')
      expect(content).toContain('/custom/zdotdir/.zshrc')
    } finally {
      process.env.ZDOTDIR = origZdotdir
    }
  })

  it('should escape single quotes in ZDOTDIR', () => {
    const origZdotdir = process.env.ZDOTDIR
    try {
      process.env.ZDOTDIR = "/path/with'quote"
      const content = buildZshRcContent('# sandbox')
      expect(content).toContain("'\\''")
    } finally {
      process.env.ZDOTDIR = origZdotdir
    }
  })
})

describe('buildOpenFolderDisableKeybindings', () => {
  it('should return an array of keybinding entries', () => {
    const keybindings = buildOpenFolderDisableKeybindings()
    expect(Array.isArray(keybindings)).toBe(true)
    expect(keybindings.length).toBeGreaterThan(0)
  })

  it('should have entries with key and command properties', () => {
    const keybindings = buildOpenFolderDisableKeybindings()
    for (const entry of keybindings) {
      expect(entry).toHaveProperty('key')
      expect(entry).toHaveProperty('command')
    }
  })

  it('should use "-" prefix in command to unbind', () => {
    const keybindings = buildOpenFolderDisableKeybindings()
    for (const entry of keybindings) {
      expect(entry.command).toMatch(/^-/)
    }
  })

  it('should include ctrl+o and cmd+o bindings', () => {
    const keybindings = buildOpenFolderDisableKeybindings()
    const keys = keybindings.map(k => k.key)
    expect(keys).toContain('ctrl+o')
    expect(keys).toContain('cmd+o')
  })

  it('should include Open Folder chord bindings', () => {
    const keybindings = buildOpenFolderDisableKeybindings()
    const keys = keybindings.map(k => k.key)
    expect(keys).toContain('ctrl+k ctrl+o')
    expect(keys).toContain('cmd+k cmd+o')
  })
})

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
