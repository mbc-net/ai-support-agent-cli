import {
  buildTlsCertCheckRequest,
  DEFAULT_TLS_CHECK_PORT,
} from '../src/commands/tls-cert-check'

function expectError(payload: unknown): string {
  const result = buildTlsCertCheckRequest(payload)
  if (!('error' in result)) {
    throw new Error(`expected an error, got ${JSON.stringify(result)}`)
  }
  return result.error
}

describe('buildTlsCertCheckRequest', () => {
  it('accepts a minimal payload and defaults the port to 443', () => {
    expect(
      buildTlsCertCheckRequest({ targets: [{ domain: 'example.com' }] }),
    ).toEqual({
      targets: [{ domain: 'example.com', port: DEFAULT_TLS_CHECK_PORT }],
    })
  })

  it('keeps an explicit port', () => {
    const result = buildTlsCertCheckRequest({
      targets: [{ domain: 'example.com', port: 8443 }],
    })
    expect(result).toEqual({ targets: [{ domain: 'example.com', port: 8443 }] })
  })

  it('trims surrounding whitespace from the domain', () => {
    const result = buildTlsCertCheckRequest({
      targets: [{ domain: '  example.com  ' }],
    })
    expect('error' in result ? null : result.targets[0].domain).toBe('example.com')
  })

  it('converts timeoutSeconds to milliseconds', () => {
    const result = buildTlsCertCheckRequest({
      targets: [{ domain: 'example.com' }],
      timeoutSeconds: 2.5,
    })
    expect('error' in result ? null : result.timeoutMs).toBe(2500)
  })

  it('passes concurrency through', () => {
    const result = buildTlsCertCheckRequest({
      targets: [{ domain: 'example.com' }],
      concurrency: 3,
    })
    expect('error' in result ? null : result.concurrency).toBe(3)
  })

  it('omits timeout and concurrency when not given, leaving the collector defaults', () => {
    const result = buildTlsCertCheckRequest({
      targets: [{ domain: 'example.com' }],
    })
    expect(result).not.toHaveProperty('timeoutMs')
    expect(result).not.toHaveProperty('concurrency')
  })

  it.each([undefined, null, 'string', 42])(
    'rejects a non-object payload: %s',
    (payload) => {
      expect(expectError(payload)).toMatch(/payload object/)
    },
  )

  it('rejects a missing targets array', () => {
    expect(expectError({})).toMatch(/non-empty targets array/)
  })

  it('rejects an empty targets array', () => {
    // An empty batch would report "checked everything, all fine" while having
    // checked nothing.
    expect(expectError({ targets: [] })).toMatch(/non-empty targets array/)
  })

  it('rejects a non-array targets value', () => {
    expect(expectError({ targets: 'example.com' })).toMatch(
      /non-empty targets array/,
    )
  })

  it('rejects a target that is not an object', () => {
    expect(expectError({ targets: ['example.com'] })).toMatch(
      /target #0 is not an object/,
    )
  })

  it('rejects a target with no domain', () => {
    expect(expectError({ targets: [{ port: 443 }] })).toMatch(
      /target #0 has no domain/,
    )
  })

  it('rejects a blank domain', () => {
    expect(expectError({ targets: [{ domain: '   ' }] })).toMatch(
      /target #0 has no domain/,
    )
  })

  it('names the offending index so a bad row in a batch is identifiable', () => {
    expect(
      expectError({
        targets: [{ domain: 'a.example.com' }, { domain: 'b.example.com' }, {}],
      }),
    ).toMatch(/target #2/)
  })

  it.each([0, 65536, -1, 1.5, '443', null])(
    'rejects an invalid port: %s',
    (port) => {
      expect(expectError({ targets: [{ domain: 'example.com', port }] })).toMatch(
        /invalid port/,
      )
    },
  )

  it.each([0, -1, 'x', NaN, Infinity])(
    'rejects an invalid timeoutSeconds: %s',
    (timeoutSeconds) => {
      expect(
        expectError({ targets: [{ domain: 'example.com' }], timeoutSeconds }),
      ).toMatch(/timeoutSeconds must be a positive number/)
    },
  )

  it.each([0, -1, 1.5, '3'])(
    'rejects an invalid concurrency: %s',
    (concurrency) => {
      expect(
        expectError({ targets: [{ domain: 'example.com' }], concurrency }),
      ).toMatch(/concurrency must be a positive integer/)
    },
  )
})
