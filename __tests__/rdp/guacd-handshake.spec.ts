import {
  GuacdHandshakeError,
  GuacdHandshakeParams,
  performGuacdHandshake,
} from '../../src/rdp/guacd-handshake'
import {
  decodeGuacamoleInstructions,
  encodeGuacamoleInstruction,
  GuacamoleInstruction,
} from '../../src/rdp/guacamole-protocol'

/**
 * guacd handshake.
 *
 * ```text
 * client -> guacd  6.select,3.rdp;
 * guacd  -> client 4.args,8.VERSION,8.hostname,4.port,8.password,...;
 * client -> guacd  4.size,...; 5.audio,...; 5.video,...; 5.image,...;
 * client -> guacd  7.connect,<one value per arg guacd asked for, in order>;
 * guacd  -> client 5.ready,37.$id;
 * ```
 *
 * The `connect` values are positional: guacd matches them to the names it sent in
 * `args`. Emitting them in any other order silently feeds the password into a
 * different parameter, which is why the ordering has its own tests here.
 */

/** Minimal in-memory socket that records what the handshake wrote. */
class FakeSocket {
  written: string[] = []
  private dataHandler: ((chunk: string) => void) | null = null
  private closeHandler: (() => void) | null = null
  private errorHandler: ((error: Error) => void) | null = null
  destroyed = false

  write(data: string): void {
    this.written.push(data)
  }
  onData(handler: (chunk: string) => void): void {
    this.dataHandler = handler
  }
  onClose(handler: () => void): void {
    this.closeHandler = handler
  }
  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler
  }
  destroy(): void {
    this.destroyed = true
  }

  /** Simulate guacd sending an instruction. */
  emit(opcode: string, args: string[]): void {
    this.dataHandler?.(encodeGuacamoleInstruction(opcode, args))
  }
  emitRaw(chunk: string): void {
    this.dataHandler?.(chunk)
  }
  close(): void {
    this.closeHandler?.()
  }
  fail(error: Error): void {
    this.errorHandler?.(error)
  }

  /** All instructions the handshake wrote, in order. */
  instructions(): GuacamoleInstruction[] {
    return decodeGuacamoleInstructions(this.written.join('')).instructions
  }
  find(opcode: string): GuacamoleInstruction | undefined {
    return this.instructions().find((i) => i.opcode === opcode)
  }
}

const PASSWORD = 'sup3r-s3cret'

const baseParams: GuacdHandshakeParams = {
  protocol: 'rdp',
  parameters: {
    hostname: '10.0.0.5',
    port: '3389',
    username: 'administrator',
    password: PASSWORD,
    domain: 'CORP',
  },
  optimalWidth: 1280,
  optimalHeight: 800,
  optimalDpi: 96,
}

/** Drive a successful handshake, letting the caller choose the `args` names. */
async function handshakeWith(
  argNames: string[],
  overrides: Partial<GuacdHandshakeParams> = {},
): Promise<{ socket: FakeSocket; connectionId: string }> {
  const socket = new FakeSocket()
  const promise = performGuacdHandshake(socket, {
    ...baseParams,
    ...overrides,
  })
  socket.emit('args', ['VERSION_1_5_0', ...argNames])
  socket.emit('ready', ['$260d01da-779b-4ee5-afc3-ba2c'])
  const result = await promise
  return { socket, connectionId: result.connectionId }
}

describe('performGuacdHandshake', () => {
  it('selects the requested protocol first', async () => {
    const { socket } = await handshakeWith(['hostname', 'port'])
    expect(socket.instructions()[0]).toEqual({
      opcode: 'select',
      args: ['rdp'],
    })
  })

  it('returns the connection id from ready', async () => {
    const { connectionId } = await handshakeWith(['hostname'])
    expect(connectionId).toBe('$260d01da-779b-4ee5-afc3-ba2c')
  })

  it('reports the optimal display size and dpi', async () => {
    const { socket } = await handshakeWith(['hostname'])
    expect(socket.find('size')).toEqual({
      opcode: 'size',
      args: ['1280', '800', '96'],
    })
  })

  it('sends audio, video and image capability instructions', async () => {
    const { socket } = await handshakeWith(['hostname'])
    for (const opcode of ['audio', 'video', 'image']) {
      expect(socket.find(opcode)).toBeDefined()
    }
  })

  describe('connect argument ordering', () => {
    it('★ emits one value per requested arg, in the order guacd asked', async () => {
      const { socket } = await handshakeWith([
        'port',
        'password',
        'hostname',
        'domain',
      ])
      expect(socket.find('connect')?.args).toEqual([
        '3389',
        PASSWORD,
        '10.0.0.5',
        'CORP',
      ])
    })

    it('★ sends an empty value for a parameter it does not have', async () => {
      const { socket } = await handshakeWith([
        'hostname',
        'initial-program',
        'password',
      ])
      expect(socket.find('connect')?.args).toEqual([
        '10.0.0.5',
        '',
        PASSWORD,
      ])
    })

    it('does not leak an unrequested parameter into the connect values', async () => {
      const { socket } = await handshakeWith(['hostname'])
      expect(socket.find('connect')?.args).toEqual(['10.0.0.5'])
    })

    it('drops the leading protocol version rather than treating it as a parameter', async () => {
      const { socket } = await handshakeWith(['hostname', 'port'])
      expect(socket.find('connect')?.args).toEqual(['10.0.0.5', '3389'])
    })
  })

  describe('failures', () => {
    it('rejects when guacd sends an error instead of args', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emit('error', ['Connection refused', '519'])
      await expect(promise).rejects.toBeInstanceOf(GuacdHandshakeError)
    })

    it('rejects when the socket closes mid-handshake', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.close()
      await expect(promise).rejects.toBeInstanceOf(GuacdHandshakeError)
    })

    it('rejects when the socket errors', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.fail(new Error('ECONNREFUSED'))
      await expect(promise).rejects.toBeInstanceOf(GuacdHandshakeError)
    })

    it('rejects malformed guacd output', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emitRaw('3nope;')
      await expect(promise).rejects.toBeInstanceOf(GuacdHandshakeError)
    })

    it('★ never includes the password in a rejection message', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emit('error', ['Authentication failed', '771'])
      await expect(promise).rejects.not.toThrow(PASSWORD)
    })

    it('rejects a ready without a connection id', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      socket.emit('ready', [])
      await expect(promise).rejects.toBeInstanceOf(GuacdHandshakeError)
    })

    it('destroys the socket when the handshake fails', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emit('error', ['nope', '519'])
      await expect(promise).rejects.toThrow()
      expect(socket.destroyed).toBe(true)
    })
  })

  describe('timeout', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })
    afterEach(() => {
      jest.useRealTimers()
    })

    it('★ rejects when guacd accepts the socket but never answers', async () => {
      // Without this, a guacd that completes the TCP handshake and then goes
      // silent leaves the promise pending forever and the session wedges with no
      // error anywhere.
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, {
        ...baseParams,
        timeoutMs: 5000,
      })
      const assertion = expect(promise).rejects.toBeInstanceOf(
        GuacdHandshakeError,
      )
      jest.advanceTimersByTime(5000)
      await assertion
      expect(socket.destroyed).toBe(true)
    })

    it('does not fire once the handshake completed', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, {
        ...baseParams,
        timeoutMs: 5000,
      })
      socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      socket.emit('ready', ['$id'])
      await expect(promise).resolves.toBeDefined()
      jest.advanceTimersByTime(60_000)
      await expect(promise).resolves.toBeDefined()
    })

    it('clears the timer so the process can exit', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, {
        ...baseParams,
        timeoutMs: 5000,
      })
      socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      socket.emit('ready', ['$id'])
      await promise
      expect(jest.getTimerCount()).toBe(0)
    })

    it('clears the timer when the handshake fails', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, {
        ...baseParams,
        timeoutMs: 5000,
      })
      socket.emit('error', ['nope', '519'])
      await expect(promise).rejects.toThrow()
      expect(jest.getTimerCount()).toBe(0)
    })
  })

  describe('capability overrides', () => {
    it('uses the supplied audio, video and image mimetypes', async () => {
      const { socket } = await handshakeWith(['hostname'], {
        audioMimetypes: ['audio/ogg'],
        videoMimetypes: ['video/webm'],
        imageMimetypes: ['image/png'],
      })
      expect(socket.find('audio')?.args).toEqual(['audio/ogg'])
      expect(socket.find('video')?.args).toEqual(['video/webm'])
      expect(socket.find('image')?.args).toEqual(['image/png'])
    })

    it('sends video with no mimetypes by default', async () => {
      const { socket } = await handshakeWith(['hostname'])
      expect(socket.find('video')?.args).toEqual([])
    })
  })

  describe('stream handling around ready', () => {
    it('hands back instructions pipelined behind ready', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      socket.emitRaw(
        encodeGuacamoleInstruction('ready', ['$id']) +
          encodeGuacamoleInstruction('sync', ['0']),
      )
      const result = await promise
      expect(result.pending).toEqual([{ opcode: 'sync', args: ['0'] }])
    })

    it('ignores a second args instruction rather than reconnecting', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      socket.emit('args', ['VERSION_1_5_0', 'password'])
      socket.emit('ready', ['$id'])
      await promise
      const connects = socket
        .instructions()
        .filter((i) => i.opcode === 'connect')
      expect(connects).toHaveLength(1)
      expect(connects[0].args).toEqual(['10.0.0.5'])
    })

    it('ignores data arriving after the handshake settled', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      socket.emit('ready', ['$id'])
      await promise
      const before = socket.written.length
      socket.emit('sync', ['1'])
      expect(socket.written).toHaveLength(before)
    })

    it('does not reject after the handshake already succeeded', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      socket.emit('ready', ['$id'])
      await expect(promise).resolves.toBeDefined()
      socket.close()
      socket.fail(new Error('late failure'))
      await expect(promise).resolves.toBeDefined()
    })

    it('skips instructions before args without failing', async () => {
      const socket = new FakeSocket()
      const promise = performGuacdHandshake(socket, baseParams)
      socket.emit('nop', [])
      socket.emit('args', ['VERSION_1_5_0', 'hostname'])
      socket.emit('ready', ['$id'])
      await expect(promise).resolves.toBeDefined()
    })
  })
})
