import {
  BROWSER_IDLE_TIMEOUT_MS,
  BROWSER_SESSION_RETRY_DELAY_MS,
  BROWSER_TIMEOUT_REQUEST_MS,
  SELECTOR_TIMEOUT_MULTIPLE_MS,
  SELECTOR_TIMEOUT_NAVIGATION_MS,
  SELECTOR_TIMEOUT_SINGLE_MS,
} from '../../../../src/mcp/tools/browser/browser-types'

describe('browser-types timing constants', () => {
  it('should keep selector / navigation timeout values stable', () => {
    expect(SELECTOR_TIMEOUT_NAVIGATION_MS).toBe(30_000)
    expect(SELECTOR_TIMEOUT_SINGLE_MS).toBe(10_000)
    expect(SELECTOR_TIMEOUT_MULTIPLE_MS).toBe(5_000)
  })

  it('should keep request / idle timeout values stable', () => {
    expect(BROWSER_TIMEOUT_REQUEST_MS).toBe(3_000)
    expect(BROWSER_IDLE_TIMEOUT_MS).toBe(5 * 60 * 1000)
  })

  it('should expose the browser session resolution retry delay', () => {
    expect(BROWSER_SESSION_RETRY_DELAY_MS).toBe(500)
  })
})
