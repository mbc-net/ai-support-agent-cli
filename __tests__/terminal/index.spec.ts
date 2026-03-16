import {
  buildSandboxInitScript,
  isZshShell,
  buildBashRcContent,
  buildZshRcContent,
  buildOpenFolderDisableKeybindings,
  TerminalSession,
  isNodePtyAvailable,
  TerminalSessionManager,
  TerminalWebSocket,
} from '../../src/terminal'

describe('terminal/index re-exports', () => {
  it('should export sandbox-init-script functions', () => {
    expect(buildSandboxInitScript).toBeDefined()
    expect(isZshShell).toBeDefined()
    expect(buildBashRcContent).toBeDefined()
    expect(buildZshRcContent).toBeDefined()
    expect(buildOpenFolderDisableKeybindings).toBeDefined()
  })

  it('should export TerminalSession and isNodePtyAvailable', () => {
    expect(TerminalSession).toBeDefined()
    expect(isNodePtyAvailable).toBeDefined()
  })

  it('should export TerminalSessionManager', () => {
    expect(TerminalSessionManager).toBeDefined()
  })

  it('should export TerminalWebSocket', () => {
    expect(TerminalWebSocket).toBeDefined()
  })
})
