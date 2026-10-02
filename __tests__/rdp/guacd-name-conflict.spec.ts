import { execFileSync } from 'child_process'

import {
  ensureGuacdContainer,
  GUACD_CONTAINER_NAME,
} from '../../src/rdp/guacd-container'
import { createLazyGuacdEndpointResolver } from '../../src/rdp/guacd-runtime'

jest.mock('../../src/logger')
jest.mock('child_process', () => ({ execFileSync: jest.fn() }))
jest.mock('../../src/docker/docker-utils', () => ({
  getDockerPath: () => '/usr/bin/docker',
}))

const exec = execFileSync as jest.Mock

/** The docker argument vectors the code under test issued. */
function calls(): string[][] {
  return exec.mock.calls.map((c) => c[1] as string[])
}

/** Every invocation of one docker subcommand. */
function callsFor(sub: string): string[][] {
  return calls().filter((args) => args[0] === sub)
}

type ContainerState = 'absent' | 'running' | 'stopped'

/**
 * Stub the docker CLI.
 *
 * `inspect` answers from `inspects` in order (the last entry repeats), so a
 * test can say "absent when we looked, running when we looked again". `run`
 * always fails with `runError`.
 */
function stubDocker(inspects: ContainerState[], runError: unknown): void {
  let i = 0
  exec.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === 'inspect') {
      const state = inspects[Math.min(i++, inspects.length - 1)]
      if (state === 'absent') {
        throw new Error(`Error: No such object: ${GUACD_CONTAINER_NAME}`)
      }
      return state === 'running' ? 'true\n' : 'false\n'
    }
    if (args[0] === 'run') throw runError
    return ''
  })
}

/**
 * The failure docker reports to the process that lost the race, shaped the way
 * `execFileSync` reports it: the daemon's wording arrives on `stderr`, and the
 * message only says the command failed.
 */
function nameConflictError(): Error {
  const err = new Error(
    '/usr/bin/docker run -d --rm --name ais-guacd ... failed with exit code 125',
  ) as Error & { stderr: Buffer; status: number }
  err.stderr = Buffer.from(
    'docker: Error response from daemon: Conflict. The container name ' +
      `"/${GUACD_CONTAINER_NAME}" is already in use by container ` +
      '"9b1deb4d3b7d4bad9bdd2b0d7b3dcb6d". You have to remove (or rename) ' +
      'that container to be able to reuse that name.\n',
  )
  err.status = 125
  return err
}

/**
 * Cross-process races on the fixed container name.
 *
 * On a host install one OS process runs per project (`fork()` in
 * `src/child-process-manager.ts`), and each of them resolves guacd lazily on
 * its first `rdp_open`. Two projects connecting at the same moment both see
 * "absent" and both issue `docker run --name ais-guacd`. `execFileSync` only
 * serialises calls inside one process; across processes nothing does.
 *
 * The docker daemon itself serialises creation by name, so the loser is refused
 * with a name conflict. That refusal is evidence that guacd *is* being started
 * by somebody else — not a failure. Reporting it as one turns a healthy guacd
 * into a fatal `RdpUnavailableError` (no automatic retry for the user) plus a
 * `not_applied(apply_failed)` line on the heartbeat.
 */
describe('ensureGuacdContainer: another process created the container first', () => {
  beforeEach(() => {
    exec.mockReset()
  })

  it('★ adopts the container the winner started and returns its endpoint', () => {
    stubDocker(['absent', 'running'], nameConflictError())

    expect(ensureGuacdContainer({ mode: 'loopback' })).toEqual({
      host: '127.0.0.1',
      port: 4822,
    })
  })

  it('★ adopts it in network mode too', () => {
    stubDocker(['absent', 'running'], nameConflictError())

    expect(ensureGuacdContainer({ mode: 'network' })).toEqual({
      host: GUACD_CONTAINER_NAME,
      port: 4822,
    })
  })

  it('recognises the conflict when docker put it on the message', () => {
    stubDocker(
      ['absent', 'running'],
      new Error(
        'Command failed: docker run\ndocker: Error response from daemon: ' +
          `Conflict. The container name "/${GUACD_CONTAINER_NAME}" is already in use.`,
      ),
    )

    expect(() => ensureGuacdContainer({ mode: 'loopback' })).not.toThrow()
  })

  it('does not tear down or re-run the container it adopted', () => {
    stubDocker(['absent', 'running'], nameConflictError())

    ensureGuacdContainer({ mode: 'loopback' })

    // Removing it would kill the session the winning process is opening.
    expect(callsFor('rm')).toHaveLength(0)
    expect(callsFor('run')).toHaveLength(1)
  })

  it('★ still fails when the re-check shows the container is not running', () => {
    // The winner's container died right after it was created: nothing to adopt.
    stubDocker(['absent', 'stopped'], nameConflictError())

    expect(() => ensureGuacdContainer({ mode: 'loopback' })).toThrow(/guacd/)
  })

  it('★ still fails when the container is gone by the time we re-check', () => {
    stubDocker(['absent', 'absent'], nameConflictError())

    expect(() => ensureGuacdContainer({ mode: 'loopback' })).toThrow(/guacd/)
  })

  it('★ does not swallow a failure that is not a name conflict', () => {
    // A missing image or a dead daemon must stay fatal; swallowing it would
    // hand back an endpoint nothing is listening on.
    stubDocker(
      ['absent', 'running'],
      new Error('docker: Error response from daemon: no such image'),
    )

    expect(() => ensureGuacdContainer({ mode: 'loopback' })).toThrow(/guacd/)
  })

  /**
   * The adopted container is stopped on exit, exactly like a reused running one
   * (`ensureGuacdContainer` has always returned success for that case, and the
   * resolver has always registered the stop hook on success).
   *
   * :::danger
   * **Not stopping it is the worse failure.** guacd has no authentication, so a
   * container left behind after the agent is gone lets anyone who can reach the
   * host open RDP to any target. Stopping one this process did not create can at
   * worst cut another project's session — which that project recovers from by
   * resolving guacd again on its next `rdp_open`, and which `--rm` leaves no
   * residue of. An unauthenticated relay nobody knows about does not recover.
   * :::
   */
  it('★ still stops guacd on exit after adopting it', () => {
    stubDocker(['absent', 'running'], nameConflictError())
    const hooks: Array<() => void> = []
    const resolve = createLazyGuacdEndpointResolver({
      env: {},
      registerShutdownHook: (stop) => hooks.push(stop),
    })

    resolve()
    expect(hooks).toHaveLength(1)

    hooks[0]()
    expect(callsFor('stop')).toEqual([['stop', GUACD_CONTAINER_NAME]])
  })

  it('★ does not treat a conflict on some other container name as ours', () => {
    const err = new Error('Command failed') as Error & { stderr: Buffer }
    err.stderr = Buffer.from(
      'docker: Error response from daemon: Conflict. The container name ' +
        '"/ais-guacd-sidecar" is already in use by container "deadbeef".',
    )
    stubDocker(['absent', 'running'], err)

    expect(() => ensureGuacdContainer({ mode: 'loopback' })).toThrow(/guacd/)
  })
})
