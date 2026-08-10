import { buildAwsCredentialEnv } from '../../src/utils/aws-credential-env'

describe('buildAwsCredentialEnv', () => {
  it('maps the three required credentials plus the passed region', () => {
    expect(
      buildAwsCredentialEnv(
        { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
        'ap-northeast-1',
      ),
    ).toEqual({
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_DEFAULT_REGION: 'ap-northeast-1',
    })
  })

  it('includes AWS_SESSION_TOKEN when a session token is present', () => {
    expect(
      buildAwsCredentialEnv(
        { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'tok' },
        'us-east-1',
      ),
    ).toEqual({
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_DEFAULT_REGION: 'us-east-1',
      AWS_SESSION_TOKEN: 'tok',
    })
  })

  it('omits AWS_SESSION_TOKEN when the session token is undefined or empty', () => {
    expect(
      buildAwsCredentialEnv(
        { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: undefined },
        'us-east-1',
      ),
    ).not.toHaveProperty('AWS_SESSION_TOKEN')
    expect(
      buildAwsCredentialEnv(
        { accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: '' },
        'us-east-1',
      ),
    ).not.toHaveProperty('AWS_SESSION_TOKEN')
  })

  it('uses the region argument, not any region on the creds object', () => {
    const result = buildAwsCredentialEnv(
      {
        accessKeyId: 'AKIA',
        secretAccessKey: 'secret',
        // extra field (superset input) must be ignored
        ...({ region: 'eu-west-1' } as Record<string, string>),
      },
      'ap-southeast-2',
    )
    expect(result.AWS_DEFAULT_REGION).toBe('ap-southeast-2')
  })
})
