import { Command, CommanderError } from 'commander'

/**
 * commander integration tests.
 *
 * Verifies the commander APIs that index.ts relies on:
 *   new Command(), .name(), .version(), .command(), .option(),
 *   .requiredOption(), .argument(), .action(), .parse(), .exitOverride()
 *
 * index.ts is NOT imported — instead, the same API surface is exercised
 * to detect breaking changes on version upgrades.
 */
describe('commander integration', () => {
  it('should create a Command with name and version', () => {
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })
      .name('test-cli')
      .version('1.0.0')

    expect(program.name()).toBe('test-cli')
    expect(program.version()).toBe('1.0.0')
  })

  it('should set default value for option with <value>', () => {
    let captured: Record<string, unknown> = {}
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    program
      .command('start')
      .option('--poll-interval <ms>', 'poll interval', '3000')
      .action((opts) => { captured = opts })

    program.parse(['node', 'test', 'start'])
    expect(captured.pollInterval).toBe('3000')
  })

  it('should parse boolean flag as true when provided, undefined when omitted', () => {
    let withFlag: Record<string, unknown> = {}
    let withoutFlag: Record<string, unknown> = {}

    // With --verbose
    const p1 = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    p1.command('start')
      .option('--verbose', 'verbose output')
      .action((opts) => { withFlag = opts })
    p1.parse(['node', 'test', 'start', '--verbose'])

    // Without --verbose
    const p2 = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    p2.command('start')
      .option('--verbose', 'verbose output')
      .action((opts) => { withoutFlag = opts })
    p2.parse(['node', 'test', 'start'])

    expect(withFlag.verbose).toBe(true)
    expect(withoutFlag.verbose).toBeUndefined()
  })

  it('should throw CommanderError for missing requiredOption with exitOverride', () => {
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    program
      .command('login')
      .requiredOption('--url <url>', 'web URL')
      .action(() => {})

    expect(() => {
      program.parse(['node', 'test', 'login'])
    }).toThrow(CommanderError)
  })

  it('should capture positional argument via .argument()', () => {
    let captured = ''
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    program
      .command('remove-project')
      .argument('<projectCode>', 'project code')
      .action((projectCode: string) => { captured = projectCode })

    program.parse(['node', 'test', 'remove-project', 'my-proj'])
    expect(captured).toBe('my-proj')
  })

  it('should route to the correct subcommand action', () => {
    let startCalled = false
    let loginCalled = false

    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    program.command('start').action(() => { startCalled = true })
    program.command('login').requiredOption('--url <url>', 'url').action(() => { loginCalled = true })

    program.parse(['node', 'test', 'start'])
    expect(startCalled).toBe(true)
    expect(loginCalled).toBe(false)
  })

  it('should support parse() with { from: "node" } option', () => {
    let captured: Record<string, unknown> = {}
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    program
      .command('start')
      .option('--poll-interval <ms>', 'poll interval', '3000')
      .action((opts) => { captured = opts })

    // { from: 'node' } is the default, matching index.ts usage of program.parse()
    program.parse(['node', 'test', 'start', '--poll-interval', '5000'], { from: 'node' })
    expect(captured.pollInterval).toBe('5000')
  })

  it('should throw CommanderError on unknown command with exitOverride', () => {
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    program.command('start').action(() => {})

    expect(() => {
      program.parse(['node', 'test', 'nonexistent'])
    }).toThrow(CommanderError)
  })

  it('should parse multiple options together (matching index.ts start command pattern)', () => {
    let captured: Record<string, unknown> = {}
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    program
      .command('start')
      .option('--token <token>', 'API token')
      .option('--api-url <url>', 'API URL')
      .option('--poll-interval <ms>', 'poll interval', '3000')
      .option('--heartbeat-interval <ms>', 'heartbeat interval', '30000')
      .option('--verbose', 'verbose output')
      .action((opts) => { captured = opts })

    program.parse([
      'node', 'test', 'start',
      '--token', 'my-token',
      '--api-url', 'http://localhost:3000',
      '--poll-interval', '5000',
      '--heartbeat-interval', '60000',
      '--verbose',
    ])

    expect(captured.token).toBe('my-token')
    expect(captured.apiUrl).toBe('http://localhost:3000')
    expect(captured.pollInterval).toBe('5000')
    expect(captured.heartbeatInterval).toBe('60000')
    expect(captured.verbose).toBe(true)
  })

  /**
   * 自動アップデートの既定 OFF は、この commander の挙動に依存している。
   *
   * `--no-auto-update` だけを定義すると、commander は否定オプションの既定値として
   * opts.autoUpdate を **true** にする。つまり「フラグ未指定」と「明示的に ON」が
   * 区別できず、既定 OFF が成立しない。`--auto-update` を併せて定義したときだけ
   * 未指定が undefined になり、三状態（未指定 / ON / OFF）が得られる。
   *
   * このテストが落ちたら、src/index.ts から --auto-update を消してはならない。
   * 消すと全エージェントで自動アップデートが暗黙的に ON へ戻る。
   */
  describe('negated boolean option defaults (auto-update opt-in の前提)', () => {
    const parseStart = (registerPositive: boolean, argv: string[]): Record<string, unknown> => {
      let captured: Record<string, unknown> = {}
      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })
      const start = program.command('start')
      if (registerPositive) {
        start.option('--auto-update', 'enable auto update')
      }
      start
        .option('--no-auto-update', 'disable auto update')
        .action((opts) => { captured = opts })
      program.parse(['node', 'test', 'start', ...argv])
      return captured
    }

    it('--no-auto-update だけを定義すると、未指定時の既定が true になってしまう', () => {
      expect(parseStart(false, []).autoUpdate).toBe(true)
    })

    it('--auto-update を併せて定義すると、未指定時は undefined になる', () => {
      expect(parseStart(true, []).autoUpdate).toBeUndefined()
    })

    it('--auto-update / --no-auto-update はそれぞれ true / false を設定する', () => {
      expect(parseStart(true, ['--auto-update']).autoUpdate).toBe(true)
      expect(parseStart(true, ['--no-auto-update']).autoUpdate).toBe(false)
    })
  })
})
