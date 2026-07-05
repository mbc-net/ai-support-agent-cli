/**
 * Tests for src/ecs/ecr-publisher.ts
 *
 * ECR calls are mocked with aws-sdk-client-mock; docker CLI calls are mocked
 * at the child_process.spawn level, following the pattern of
 * __tests__/docker/project-image-builder.spec.ts.
 */

import { EventEmitter } from 'events'

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

jest.mock('../../src/docker/docker-utils', () => ({
  getDockerPath: jest.fn().mockReturnValue('docker'),
}))

import { spawn } from 'child_process'
import { DescribeImagesCommand, ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr'
import { mockClient } from 'aws-sdk-client-mock'

import { getImageDigest, loginToEcr, publishImage, runDocker } from '../../src/ecs/ecr-publisher'

const mockSpawn = spawn as jest.MockedFunction<typeof spawn>
const ecrMock = mockClient(ECRClient)

const REPO_URI = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/my-repo'
const REGISTRY = '123456789012.dkr.ecr.ap-northeast-1.amazonaws.com'
const DIGEST = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

interface FakeStdin {
  write: jest.Mock
  end: jest.Mock
  on: jest.Mock
  /** Emit the 'error' event registered via on('error', ...). */
  emitError: (err: Error) => void
}

interface FakeProc extends EventEmitter {
  stdin: FakeStdin | null
}

function makeFakeStdin(): FakeStdin {
  let errorHandler: ((err: Error) => void) | undefined
  const on = jest.fn((event: string, handler: (err: Error) => void) => {
    if (event === 'error') errorHandler = handler
  })
  return {
    write: jest.fn(),
    end: jest.fn(),
    on,
    emitError: (err: Error) => errorHandler?.(err),
  }
}

/** Register the next spawn() call to exit with the given code. */
function nextSpawn(exitCode: number, options?: { emitError?: Error }): { proc: FakeProc; args: () => string[] } {
  const proc = new EventEmitter() as FakeProc
  proc.stdin = makeFakeStdin()
  let capturedArgs: string[] = []
  mockSpawn.mockImplementationOnce(((cmd: string, args: string[]) => {
    capturedArgs = args
    process.nextTick(() => {
      if (options?.emitError) {
        proc.emit('error', options.emitError)
      } else {
        proc.emit('close', exitCode)
      }
    })
    return proc as never
  }) as never)
  return { proc, args: () => capturedArgs }
}

function mockAuthToken(decoded = 'AWS:ecr-password'): void {
  ecrMock.on(GetAuthorizationTokenCommand).resolves({
    authorizationData: [{ authorizationToken: Buffer.from(decoded).toString('base64') }],
  })
}

beforeEach(() => {
  ecrMock.reset()
  jest.clearAllMocks()
})

describe('runDocker', () => {
  it('resolves when docker exits with code 0', async () => {
    nextSpawn(0)
    await expect(runDocker(['push', 'x'])).resolves.toBeUndefined()
    expect(mockSpawn).toHaveBeenCalledWith('docker', ['push', 'x'], expect.objectContaining({
      stdio: ['ignore', 'inherit', 'inherit'],
    }))
  })

  it('writes the input to stdin and ends it (password-stdin path)', async () => {
    const { proc } = nextSpawn(0)
    await runDocker(['login', '--password-stdin'], 'secret')
    expect(proc.stdin?.write).toHaveBeenCalledWith('secret')
    expect(proc.stdin?.end).toHaveBeenCalled()
    expect(proc.stdin?.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(mockSpawn).toHaveBeenCalledWith('docker', ['login', '--password-stdin'], expect.objectContaining({
      stdio: ['pipe', 'inherit', 'inherit'],
    }))
  })

  it('does not surface a stdin EPIPE as an uncaught error; reports the real exit code', async () => {
    // Child dies instantly (e.g. `docker login` fails), then stdin emits EPIPE.
    const proc = new EventEmitter() as FakeProc
    const stdin = makeFakeStdin()
    proc.stdin = stdin
    mockSpawn.mockImplementationOnce(((_cmd: string, _args: string[]) => {
      process.nextTick(() => {
        stdin.emitError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
        proc.emit('close', 1)
      })
      return proc as never
    }) as never)

    // The EPIPE must be swallowed; the rejection comes from the non-zero exit.
    await expect(runDocker(['login', '--password-stdin'], 'secret'))
      .rejects.toThrow('docker login exited with code 1')
  })

  it('rejects when docker exits with a non-zero code', async () => {
    nextSpawn(1)
    await expect(runDocker(['build', '.'])).rejects.toThrow('docker build exited with code 1')
  })

  it('rejects when spawn emits an error', async () => {
    nextSpawn(0, { emitError: new Error('ENOENT') })
    await expect(runDocker(['push', 'x'])).rejects.toThrow('ENOENT')
  })
})

describe('loginToEcr', () => {
  it('decodes the authorization token and logs in via stdin', async () => {
    mockAuthToken('AWS:my-ecr-password')
    const { proc, args } = nextSpawn(0)

    await loginToEcr(new ECRClient({ region: 'ap-northeast-1' }), REGISTRY)

    expect(args()).toEqual(['login', '--username', 'AWS', '--password-stdin', REGISTRY])
    expect(proc.stdin?.write).toHaveBeenCalledWith('my-ecr-password')
    // The password must never appear in argv
    expect(args().join(' ')).not.toContain('my-ecr-password')
  })

  it('keeps colons inside the password intact', async () => {
    mockAuthToken('AWS:pass:with:colons')
    const { proc } = nextSpawn(0)

    await loginToEcr(new ECRClient({ region: 'ap-northeast-1' }), REGISTRY)

    expect(proc.stdin?.write).toHaveBeenCalledWith('pass:with:colons')
  })

  it('throws when GetAuthorizationToken returns no data', async () => {
    ecrMock.on(GetAuthorizationTokenCommand).resolves({ authorizationData: [] })
    await expect(loginToEcr(new ECRClient({ region: 'ap-northeast-1' }), REGISTRY))
      .rejects.toThrow('no authorization data')
  })

  it('throws when the decoded token has no colon separator', async () => {
    ecrMock.on(GetAuthorizationTokenCommand).resolves({
      authorizationData: [{ authorizationToken: Buffer.from('no-separator').toString('base64') }],
    })
    await expect(loginToEcr(new ECRClient({ region: 'ap-northeast-1' }), REGISTRY))
      .rejects.toThrow('unexpected format')
  })
})

describe('getImageDigest', () => {
  it('returns the digest from DescribeImages', async () => {
    ecrMock.on(DescribeImagesCommand).resolves({ imageDetails: [{ imageDigest: DIGEST }] })

    const digest = await getImageDigest(new ECRClient({ region: 'ap-northeast-1' }), 'my-repo', 'v1')

    expect(digest).toBe(DIGEST)
    const input = ecrMock.commandCalls(DescribeImagesCommand)[0].args[0].input
    expect(input).toEqual({ repositoryName: 'my-repo', imageIds: [{ imageTag: 'v1' }] })
  })

  it('throws when no digest is returned', async () => {
    ecrMock.on(DescribeImagesCommand).resolves({ imageDetails: [] })
    await expect(getImageDigest(new ECRClient({ region: 'ap-northeast-1' }), 'my-repo', 'v1'))
      .rejects.toThrow('Could not resolve image digest for my-repo:v1')
  })
})

describe('publishImage', () => {
  it('builds, pushes, and returns the digest-pinned image URI', async () => {
    mockAuthToken()
    ecrMock.on(DescribeImagesCommand).resolves({ imageDetails: [{ imageDigest: DIGEST }] })
    const login = nextSpawn(0)
    const build = nextSpawn(0)
    const push = nextSpawn(0)

    const result = await publishImage({ repositoryUri: REPO_URI, tag: 'v1' })

    expect(result).toEqual({
      imageUri: `${REPO_URI}@${DIGEST}`,
      imageTag: 'v1',
      imageDigest: DIGEST,
    })
    expect(login.args()[0]).toBe('login')
    expect(build.args()).toEqual(['build', '-t', `${REPO_URI}:v1`, '.'])
    expect(push.args()).toEqual(['push', `${REPO_URI}:v1`])
  })

  it('passes -f when a dockerfile is specified', async () => {
    mockAuthToken()
    ecrMock.on(DescribeImagesCommand).resolves({ imageDetails: [{ imageDigest: DIGEST }] })
    nextSpawn(0) // login
    const build = nextSpawn(0)
    nextSpawn(0) // push

    await publishImage({ repositoryUri: REPO_URI, tag: 'v1', dockerfile: 'docker/Dockerfile.custom', contextDir: 'ctx' })

    expect(build.args()).toEqual(['build', '-t', `${REPO_URI}:v1`, '-f', 'docker/Dockerfile.custom', 'ctx'])
  })

  it('tags an existing local image instead of building when --image is given', async () => {
    mockAuthToken()
    ecrMock.on(DescribeImagesCommand).resolves({ imageDetails: [{ imageDigest: DIGEST }] })
    nextSpawn(0) // login
    const tag = nextSpawn(0)
    const push = nextSpawn(0)

    await publishImage({ repositoryUri: REPO_URI, tag: 'v2', image: 'local-image:latest' })

    expect(tag.args()).toEqual(['tag', 'local-image:latest', `${REPO_URI}:v2`])
    expect(push.args()).toEqual(['push', `${REPO_URI}:v2`])
    // Exactly 3 docker invocations: login, tag, push (no build)
    expect(mockSpawn).toHaveBeenCalledTimes(3)
  })

  it('rejects an invalid ECR repository URI before calling AWS or docker', async () => {
    await expect(publishImage({ repositoryUri: 'docker.io/nginx', tag: 'v1' }))
      .rejects.toThrow('Invalid ECR repository URI')
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(ecrMock.commandCalls(GetAuthorizationTokenCommand)).toHaveLength(0)
  })

  it('propagates a push failure', async () => {
    mockAuthToken()
    nextSpawn(0) // login
    nextSpawn(0) // build
    nextSpawn(1) // push fails

    await expect(publishImage({ repositoryUri: REPO_URI, tag: 'v1' }))
      .rejects.toThrow('docker push exited with code 1')
    expect(ecrMock.commandCalls(DescribeImagesCommand)).toHaveLength(0)
  })
})
