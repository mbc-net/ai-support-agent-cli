import { execFileSync, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'

import { performGuacdHandshake } from '../../src/rdp/guacd-handshake'
import { connectToGuacd } from '../../src/rdp/guacd-tcp-socket'

/**
 * The handshake against a **real** guacd 1.5.5 (the version the agent pins).
 *
 * The unit tests fix what the agent writes; only a real guacd can say whether
 * guacd accepts it. The `connect` without the protocol version passed every
 * unit test and was still refused by guacd 1.5.5 ("Client did not return the
 * expected number of arguments").
 *
 * Needs Docker and the image (pulled if missing). Without either the suite is
 * **skipped, and says why** on stderr — never silently green. The RDP target
 * does not exist: guacd sends `ready` once it accepts the connect arguments,
 * before it reaches the RDP host.
 */

const IMAGE = 'guacamole/guacd:1.5.5'

function dockerAvailability(): { ok: true } | { ok: false; reason: string } {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 })
  } catch {
    return { ok: false, reason: 'docker is not available' }
  }
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 15_000 })
  } catch {
    try {
      execFileSync('docker', ['pull', IMAGE], { stdio: 'ignore', timeout: 300_000 })
    } catch {
      return { ok: false, reason: `${IMAGE} is not present and could not be pulled` }
    }
  }
  return { ok: true }
}

const availability = dockerAvailability()
if (!availability.ok) {
  // Visible in the test output: a skipped suite must not read as a pass.
  process.stderr.write(
    `[guacd-handshake-docker] SKIPPED: ${availability.reason}. The handshake was NOT checked against a real guacd.\n`,
  )
}
const describeWithDocker = availability.ok ? describe : describe.skip

describeWithDocker(`guacd handshake against a real ${IMAGE}`, () => {
  jest.setTimeout(120_000)

  const name = `ais-guacd-handshake-${randomBytes(4).toString('hex')}`
  let port = 0

  beforeAll(async () => {
    execFileSync(
      'docker',
      ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::4822', IMAGE],
      { stdio: 'ignore', timeout: 60_000 },
    )
    const mapping = execFileSync('docker', ['port', name, '4822/tcp'], {
      encoding: 'utf8',
      timeout: 15_000,
    })
    port = Number(mapping.trim().split('\n')[0].split(':').pop())
    // guacd needs a moment after the container starts.
    const deadline = Date.now() + 60_000
    for (;;) {
      try {
        const probe = await connectToGuacd('127.0.0.1', port, 2_000)
        probe.destroy()
        break
      } catch (error) {
        if (Date.now() > deadline) throw error
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  })

  afterAll(() => {
    try {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 })
    } catch {
      // best effort
    }
  })

  it('★ guacd accepts the connect arguments: the RDP plugin joins (not just ready)', async () => {
    // guacd 1.5.5 sends `ready` **before** the RDP plugin validates the
    // arguments. With a wrong argument count the join fails right after
    // ("Client did not return the expected number of arguments") and nothing
    // follows `ready`. A joined plugin starts drawing (`size` / `img` ...), so
    // that is what this waits for.
    const socket = await connectToGuacd('127.0.0.1', port)
    const result = await performGuacdHandshake(socket, {
      protocol: 'rdp',
      // Nothing listens there; the join does not need the RDP host.
      parameters: { hostname: '127.0.0.1', port: '1', 'ignore-cert': 'true' },
      optimalWidth: 1024,
      optimalHeight: 768,
      optimalDpi: 96,
      timeoutMs: 60_000,
    })
    expect(result.connectionId).toMatch(/^\$/)

    const opcodes: string[] = result.pending.map((i) => i.opcode)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 15_000)
      if (opcodes.includes('size')) {
        clearTimeout(timer)
        resolve()
        return
      }
      socket.onData((chunk) => {
        for (const instruction of result.decoder.push(chunk)) opcodes.push(instruction.opcode)
        if (opcodes.includes('size')) {
          clearTimeout(timer)
          resolve()
        }
      })
      socket.onClose(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    socket.destroy()

    // guacd logs to stderr; take both streams.
    const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8', timeout: 15_000 })
    const guacdLog = `${logs.stdout}${logs.stderr}`
    expect(guacdLog).not.toMatch(/expected number of arguments/)
    expect(opcodes).toContain('size')
  })
})
