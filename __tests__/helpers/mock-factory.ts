import { EventEmitter } from 'events'

/**
 * Mock child process with manual event handler registration (jest.fn()-based).
 * Used by tests that mock `child_process.spawn` at the module level.
 * Supports emitStdout(), emitStderr(), and emit() for triggering events.
 */
export interface MockChildProcess {
  pid: number
  killed: boolean
  kill: jest.Mock
  stdout: {
    on: jest.Mock
  }
  stderr: {
    on: jest.Mock
  }
  on: jest.Mock
  emit(event: string, ...args: unknown[]): void
  emitStdout(event: string, ...args: unknown[]): void
  emitStderr(event: string, ...args: unknown[]): void
}

/**
 * Creates a mock child process with jest.fn()-based event handlers.
 * Used in tests where child_process is mocked at the module level
 * (e.g., jest.mock('child_process', () => ({ spawn: jest.fn() }))).
 *
 * Used by: claude-code-runner.spec.ts, chat-executor.spec.ts
 */
export function createMockChildProcess(): MockChildProcess {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  const stdoutHandlers: Record<string, ((...args: unknown[]) => void)[]> = {}
  const stderrHandlers: Record<string, ((...args: unknown[]) => void)[]> = {}

  return {
    pid: 12345,
    killed: false,
    kill: jest.fn(),
    stdout: {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
        stdoutHandlers[event] = stdoutHandlers[event] || []
        stdoutHandlers[event].push(cb)
      }),
    },
    stderr: {
      on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
        stderrHandlers[event] = stderrHandlers[event] || []
        stderrHandlers[event].push(cb)
      }),
    },
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers[event] = handlers[event] || []
      handlers[event].push(cb)
    }),
    emit(event: string, ...args: unknown[]) {
      for (const cb of handlers[event] || []) cb(...args)
    },
    emitStdout(event: string, ...args: unknown[]) {
      for (const cb of stdoutHandlers[event] || []) cb(...args)
    },
    emitStderr(event: string, ...args: unknown[]) {
      for (const cb of stderrHandlers[event] || []) cb(...args)
    },
  }
}

/**
 * Fake child process using EventEmitter (real event system).
 * Used by tests that spy on child_process.spawn with jest.spyOn().
 *
 * Used by: shell-executor.spec.ts, command-executor.spec.ts
 */
export interface FakeChildProcess extends InstanceType<typeof EventEmitter> {
  stdout: InstanceType<typeof EventEmitter>
  stderr: InstanceType<typeof EventEmitter>
  kill: jest.Mock
}

/**
 * Creates a fake child process based on EventEmitter.
 * Used in tests where child_process.spawn is spied on (not fully mocked).
 *
 * Used by: shell-executor.spec.ts, command-executor.spec.ts
 */
export function createFakeChildProcess(): FakeChildProcess {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: jest.fn(),
  })
  return proc as FakeChildProcess
}

/**
 * Waits for a spawn spy to have been called at least once.
 * Polls at 5ms intervals until the spy has recorded a call.
 *
 * Used by: shell-executor.spec.ts, command-executor.spec.ts
 */
export function waitForSpawn(spy: jest.SpiedFunction<typeof import('child_process').spawn>): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (spy.mock.calls.length > 0) {
        resolve()
      } else {
        setTimeout(check, 5)
      }
    }
    check()
  })
}

/**
 * Creates an axios-like error object with isAxiosError flag and response status.
 *
 * Used by: api-client.spec.ts
 */
export function createAxiosError(message: string, status: number): Error & { isAxiosError: boolean; response: { status: number } } {
  const error = new Error(message) as Error & { isAxiosError: boolean; response: { status: number } }
  error.isAxiosError = true
  error.response = { status }
  return error
}
