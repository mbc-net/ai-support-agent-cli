import { createActivityTimeout } from '../../src/utils/activity-timeout'

describe('createActivityTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should call onTimeout after specified duration of inactivity', () => {
    const onTimeout = jest.fn()
    createActivityTimeout(1000, onTimeout)

    jest.advanceTimersByTime(999)
    expect(onTimeout).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('should reset the timer when reset() is called', () => {
    const onTimeout = jest.fn()
    const timeout = createActivityTimeout(1000, onTimeout)

    jest.advanceTimersByTime(800)
    timeout.reset()

    jest.advanceTimersByTime(800)
    expect(onTimeout).not.toHaveBeenCalled()

    jest.advanceTimersByTime(200)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('should not call onTimeout after clear()', () => {
    const onTimeout = jest.fn()
    const timeout = createActivityTimeout(1000, onTimeout)

    jest.advanceTimersByTime(500)
    timeout.clear()

    jest.advanceTimersByTime(1000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('should handle multiple resets', () => {
    const onTimeout = jest.fn()
    const timeout = createActivityTimeout(1000, onTimeout)

    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(500)
      timeout.reset()
    }

    expect(onTimeout).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('should not call onTimeout while paused', () => {
    const onTimeout = jest.fn()
    const timeout = createActivityTimeout(1000, onTimeout)

    jest.advanceTimersByTime(500)
    timeout.pause()

    jest.advanceTimersByTime(2000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('should resume timing after pause followed by reset', () => {
    const onTimeout = jest.fn()
    const timeout = createActivityTimeout(1000, onTimeout)

    jest.advanceTimersByTime(500)
    timeout.pause()

    jest.advanceTimersByTime(5000)
    expect(onTimeout).not.toHaveBeenCalled()

    timeout.reset()
    jest.advanceTimersByTime(999)
    expect(onTimeout).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('should be safe to call pause() multiple times', () => {
    const onTimeout = jest.fn()
    const timeout = createActivityTimeout(1000, onTimeout)

    timeout.pause()
    timeout.pause()

    jest.advanceTimersByTime(2000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('should use fallback timeout when maxPauseMs is provided', () => {
    const onTimeout = jest.fn()
    const timeout = createActivityTimeout(1000, onTimeout, 5000)

    timeout.pause()

    // Should not fire at normal timeout
    jest.advanceTimersByTime(1000)
    expect(onTimeout).not.toHaveBeenCalled()

    // Should fire at maxPauseMs
    jest.advanceTimersByTime(4000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('should cancel fallback timeout on reset after pause', () => {
    const onTimeout = jest.fn()
    const timeout = createActivityTimeout(1000, onTimeout, 5000)

    timeout.pause()
    jest.advanceTimersByTime(3000)
    expect(onTimeout).not.toHaveBeenCalled()

    // Reset cancels the fallback and starts normal timer
    timeout.reset()
    jest.advanceTimersByTime(999)
    expect(onTimeout).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it('should be safe to call clear() multiple times', () => {
    const onTimeout = jest.fn()
    const timeout = createActivityTimeout(1000, onTimeout)

    timeout.clear()
    timeout.clear()

    jest.advanceTimersByTime(2000)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
