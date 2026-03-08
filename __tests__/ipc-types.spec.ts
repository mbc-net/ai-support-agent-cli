import { isParentToChildMessage, isChildToParentMessage } from '../src/ipc-types'

describe('isParentToChildMessage', () => {
  it('should accept a valid start message', () => {
    expect(
      isParentToChildMessage({
        type: 'start',
        project: { projectCode: 'p1', token: 't', apiUrl: 'http://x' },
        agentId: 'a1',
        options: { pollInterval: 3000, heartbeatInterval: 60000 },
      }),
    ).toBe(true)
  })

  it('should accept a shutdown message', () => {
    expect(isParentToChildMessage({ type: 'shutdown' })).toBe(true)
  })

  it('should accept an update message', () => {
    expect(isParentToChildMessage({ type: 'update' })).toBe(true)
  })

  it('should reject start message without project', () => {
    expect(
      isParentToChildMessage({ type: 'start', agentId: 'a1', options: {} }),
    ).toBe(false)
  })

  it('should reject start message without agentId', () => {
    expect(
      isParentToChildMessage({ type: 'start', project: {}, options: {} }),
    ).toBe(false)
  })

  it('should reject start message without options', () => {
    expect(
      isParentToChildMessage({ type: 'start', project: {}, agentId: 'a1' }),
    ).toBe(false)
  })

  it('should reject non-object values', () => {
    expect(isParentToChildMessage(null)).toBe(false)
    expect(isParentToChildMessage(undefined)).toBe(false)
    expect(isParentToChildMessage('string')).toBe(false)
    expect(isParentToChildMessage(42)).toBe(false)
  })

  it('should reject unknown type', () => {
    expect(isParentToChildMessage({ type: 'unknown' })).toBe(false)
  })
})

describe('isChildToParentMessage', () => {
  it('should accept a started message', () => {
    expect(
      isChildToParentMessage({ type: 'started', projectCode: 'p1' }),
    ).toBe(true)
  })

  it('should accept a stopped message', () => {
    expect(
      isChildToParentMessage({ type: 'stopped', projectCode: 'p1' }),
    ).toBe(true)
  })

  it('should accept an error message', () => {
    expect(
      isChildToParentMessage({ type: 'error', projectCode: 'p1', message: 'fail' }),
    ).toBe(true)
  })

  it('should reject started without projectCode', () => {
    expect(isChildToParentMessage({ type: 'started' })).toBe(false)
  })

  it('should reject stopped without projectCode', () => {
    expect(isChildToParentMessage({ type: 'stopped' })).toBe(false)
  })

  it('should reject error without message', () => {
    expect(
      isChildToParentMessage({ type: 'error', projectCode: 'p1' }),
    ).toBe(false)
  })

  it('should reject error without projectCode', () => {
    expect(
      isChildToParentMessage({ type: 'error', message: 'fail' }),
    ).toBe(false)
  })

  it('should reject non-object values', () => {
    expect(isChildToParentMessage(null)).toBe(false)
    expect(isChildToParentMessage(undefined)).toBe(false)
    expect(isChildToParentMessage('string')).toBe(false)
    expect(isChildToParentMessage(42)).toBe(false)
  })

  it('should reject unknown type', () => {
    expect(isChildToParentMessage({ type: 'unknown' })).toBe(false)
  })
})
