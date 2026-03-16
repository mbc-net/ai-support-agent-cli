import {
  VsCodeServer,
  VsCodeTunnelWebSocket,
  VsCodeWsProxy,
  proxyHttpRequest,
} from '../../src/vscode'

describe('vscode/index re-exports', () => {
  it('should export VsCodeServer', () => {
    expect(VsCodeServer).toBeDefined()
  })

  it('should export VsCodeTunnelWebSocket', () => {
    expect(VsCodeTunnelWebSocket).toBeDefined()
  })

  it('should export VsCodeWsProxy', () => {
    expect(VsCodeWsProxy).toBeDefined()
  })

  it('should export proxyHttpRequest', () => {
    expect(proxyHttpRequest).toBeDefined()
  })
})
