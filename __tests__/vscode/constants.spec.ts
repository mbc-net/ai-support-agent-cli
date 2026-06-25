import {
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_REQUEST_TIMEOUT_MS,
  STARTUP_HEALTH_POLL_MS,
  STARTUP_TIMEOUT_MS,
  VSCODE_DEFAULT_PORT,
  VSCODE_IDLE_TIMEOUT_MS,
} from '../../src/vscode/constants'

describe('vscode constants', () => {
  it('should keep startup / health timeout values stable', () => {
    expect(STARTUP_TIMEOUT_MS).toBe(30 * 1000)
    expect(HEALTH_CHECK_INTERVAL_MS).toBe(30 * 1000)
    expect(HEALTH_CHECK_REQUEST_TIMEOUT_MS).toBe(5_000)
  })

  it('should expose the startup health-check poll interval', () => {
    expect(STARTUP_HEALTH_POLL_MS).toBe(500)
  })

  it('should keep core code-server defaults stable', () => {
    expect(VSCODE_DEFAULT_PORT).toBe(8443)
    expect(VSCODE_IDLE_TIMEOUT_MS).toBe(10 * 60 * 1000)
  })
})
