import { Command } from 'commander'

import { ApiClient } from '../../src/api-client'
import { startAuthServer } from '../../src/auth-server'
import { addProject } from '../../src/config-manager'
import { DEFAULT_LOGIN_URL } from '../../src/constants'
import { logger } from '../../src/logger'
import { registerAuthCommands } from '../../src/cli/auth-commands'

jest.mock('../../src/api-client')
jest.mock('../../src/auth-server')
jest.mock('../../src/config-manager')
jest.mock('../../src/logger')
jest.mock('open', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(undefined),
}))

const mockedStartAuthServer = startAuthServer as jest.MockedFunction<typeof startAuthServer>
const mockedAddProject = addProject as jest.MockedFunction<typeof addProject>
const MockedApiClient = ApiClient as jest.MockedClass<typeof ApiClient>

describe('cli/auth-commands', () => {
  let exitSpy: jest.Spied<typeof process.exit>

  beforeEach(() => {
    jest.clearAllMocks()
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  it('should register login, add-project, and configure commands', () => {
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    registerAuthCommands(program)

    const commandNames = program.commands.map((cmd) => cmd.name())
    expect(commandNames).toContain('login')
    expect(commandNames).toContain('add-project')
    expect(commandNames).toContain('configure')
  })

  it('login should default to production URL when --url is omitted', async () => {
    mockedStartAuthServer.mockResolvedValue({
      url: 'http://localhost:12345',
      nonce: 'test-nonce',
      waitForCallback: jest.fn().mockResolvedValue({
        token: 'auth-token',
        apiUrl: 'http://callback-api',
        projectCode: 'my-proj',
      }),
      stop: jest.fn(),
    })

    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    registerAuthCommands(program)

    const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!
    await loginCmd.parseAsync(['node', 'test'])

    expect(mockedStartAuthServer).toHaveBeenCalledWith(
      undefined,
      DEFAULT_LOGIN_URL,
    )
  })

  it('configure should require --token and --api-url options', () => {
    const program = new Command()
      .exitOverride()
      .configureOutput({ writeOut: () => {}, writeErr: () => {} })

    registerAuthCommands(program)

    expect(() => {
      program.parse(['node', 'test', 'configure'])
    }).toThrow()
  })

  describe('configure action', () => {
    it('should auto-resolve projectCode from API when --project-code is not specified', async () => {
      const mockGetProjectConfig = jest.fn().mockResolvedValue({
        project: { projectCode: 'RESOLVED_01', projectName: 'Resolved Project' },
        configHash: 'hash',
        agent: { agentEnabled: true, builtinAgentEnabled: true, builtinFallbackEnabled: true },
      })
      MockedApiClient.mockImplementation(() => ({
        getProjectConfig: mockGetProjectConfig,
      }) as unknown as ApiClient)

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const configureCmd = program.commands.find((cmd) => cmd.name() === 'configure')!
      await configureCmd.parseAsync(['node', 'test', '--token', 'my-token', '--api-url', 'http://my-api'])

      expect(MockedApiClient).toHaveBeenCalledWith('http://my-api', 'my-token')
      expect(mockGetProjectConfig).toHaveBeenCalled()
      expect(mockedAddProject).toHaveBeenCalledWith({
        projectCode: 'RESOLVED_01',
        token: 'my-token',
        apiUrl: 'http://my-api',
      })
      expect(logger.success).toHaveBeenCalled()
    })

    it('should exit with error when API resolution fails', async () => {
      MockedApiClient.mockImplementation(() => ({
        getProjectConfig: jest.fn().mockRejectedValue(new Error('Network error')),
      }) as unknown as ApiClient)

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const configureCmd = program.commands.find((cmd) => cmd.name() === 'configure')!
      await expect(
        configureCmd.parseAsync(['node', 'test', '--token', 'my-token', '--api-url', 'http://my-api']),
      ).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(logger.error).toHaveBeenCalled()
      expect(mockedAddProject).not.toHaveBeenCalled()
    })

    it('should save project with custom project code (skip API resolution)', async () => {
      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const configureCmd = program.commands.find((cmd) => cmd.name() === 'configure')!
      await configureCmd.parseAsync(['node', 'test', '--token', 'my-token', '--api-url', 'http://my-api', '--project-code', 'my-proj'])

      expect(MockedApiClient).not.toHaveBeenCalled()
      expect(mockedAddProject).toHaveBeenCalledWith({
        projectCode: 'my-proj',
        token: 'my-token',
        apiUrl: 'http://my-api',
      })
    })

    it('should exit with error for invalid API URL', async () => {
      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const configureCmd = program.commands.find((cmd) => cmd.name() === 'configure')!
      await expect(
        configureCmd.parseAsync(['node', 'test', '--token', 'my-token', '--api-url', 'not-a-url']),
      ).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
    })
  })

  describe('login action (browser auth)', () => {
    it('should call performBrowserAuth and add project on success', async () => {
      mockedStartAuthServer.mockResolvedValue({
        url: 'http://localhost:12345',
        nonce: 'test-nonce',
        waitForCallback: jest.fn().mockResolvedValue({
          token: 'auth-token',
          apiUrl: 'http://callback-api',
          projectCode: 'my-proj',
        }),
        stop: jest.fn(),
      })

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      // parse triggers async action — need to await it
      const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!
      await loginCmd.parseAsync(['node', 'test', '--url', 'http://my-web'])

      expect(mockedStartAuthServer).toHaveBeenCalled()
      expect(mockedAddProject).toHaveBeenCalledWith({
        projectCode: 'my-proj',
        token: 'auth-token',
        apiUrl: 'http://callback-api',
      })
      expect(logger.success).toHaveBeenCalled()
    })

    it('should exit with error when auth server fails', async () => {
      mockedStartAuthServer.mockRejectedValue(new Error('Auth server failed'))

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!
      await expect(
        loginCmd.parseAsync(['node', 'test', '--url', 'http://my-web']),
      ).rejects.toThrow('process.exit called')
      expect(logger.error).toHaveBeenCalled()
    })

    it('should exit when URL has invalid protocol', async () => {
      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!
      await expect(
        loginCmd.parseAsync(['node', 'test', '--url', 'ftp://invalid']),
      ).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('should use default project code when callback has none', async () => {
      mockedStartAuthServer.mockResolvedValue({
        url: 'http://localhost:12345',
        nonce: 'test-nonce',
        waitForCallback: jest.fn().mockResolvedValue({
          token: 'auth-token',
          apiUrl: 'http://callback-api',
        }),
        stop: jest.fn(),
      })

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!
      await loginCmd.parseAsync(['node', 'test', '--url', 'http://my-web'])

      expect(mockedAddProject).toHaveBeenCalledWith(
        expect.objectContaining({ projectCode: 'default' }),
      )
    })

    it('should exit when callback has no apiUrl and no --api-url', async () => {
      mockedStartAuthServer.mockResolvedValue({
        url: 'http://localhost:12345',
        nonce: 'test-nonce',
        waitForCallback: jest.fn().mockResolvedValue({
          token: 'auth-token',
        }),
        stop: jest.fn(),
      })

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!
      await expect(
        loginCmd.parseAsync(['node', 'test', '--url', 'http://my-web']),
      ).rejects.toThrow('process.exit called')
    })

    it('should use --api-url when callback has no apiUrl', async () => {
      mockedStartAuthServer.mockResolvedValue({
        url: 'http://localhost:12345',
        nonce: 'test-nonce',
        waitForCallback: jest.fn().mockResolvedValue({
          token: 'auth-token',
          projectCode: 'my-proj',
        }),
        stop: jest.fn(),
      })

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!
      await loginCmd.parseAsync(['node', 'test', '--url', 'http://my-web', '--api-url', 'http://override-api'])

      expect(mockedAddProject).toHaveBeenCalledWith(
        expect.objectContaining({ apiUrl: 'http://override-api' }),
      )
    })

    it('should validate port option', async () => {
      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!
      await expect(
        loginCmd.parseAsync(['node', 'test', '--url', 'http://my-web', '--port', 'invalid']),
      ).rejects.toThrow('process.exit called')
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('should accept valid port option', async () => {
      mockedStartAuthServer.mockResolvedValue({
        url: 'http://localhost:8888',
        nonce: 'test-nonce',
        waitForCallback: jest.fn().mockResolvedValue({
          token: 'auth-token',
          apiUrl: 'http://callback-api',
          projectCode: 'my-proj',
        }),
        stop: jest.fn(),
      })

      const program = new Command()
        .exitOverride()
        .configureOutput({ writeOut: () => {}, writeErr: () => {} })

      registerAuthCommands(program)

      const loginCmd = program.commands.find((cmd) => cmd.name() === 'login')!
      await loginCmd.parseAsync(['node', 'test', '--url', 'http://my-web', '--port', '8888'])

      expect(mockedStartAuthServer).toHaveBeenCalledWith(8888, 'http://my-web')
    })
  })
})
