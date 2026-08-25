/**
 * Dispatch tests for the `tls_cert_check` command handler in
 * src/commands/index.ts (routing/validation wiring only — payload validation
 * is covered by __tests__/tls-cert-check.spec.ts and the handshake itself by
 * __tests__/tls-cert-collector.spec.ts).
 */

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}))

const mockCollectTlsCertificates = jest.fn()
jest.mock('../../src/tls-cert/tls-cert-collector', () => ({
  collectTlsCertificates: (...args: unknown[]) => mockCollectTlsCertificates(...args),
}))

import { executeCommand } from '../../src/commands'

beforeEach(() => {
  jest.clearAllMocks()
  mockCollectTlsCertificates.mockResolvedValue([])
})

describe('tls_cert_check dispatch', () => {
  it('collects certificates for the requested targets and returns the observations', async () => {
    const observations = [
      {
        domain: 'example.com',
        port: 443,
        reachable: true,
        notAfter: '2026-09-24T23:59:59.000Z',
      },
    ]
    mockCollectTlsCertificates.mockResolvedValue(observations)

    const result = await executeCommand('tls_cert_check', {
      targets: [{ domain: 'example.com' }],
    })

    expect(result).toEqual({ success: true, data: { observations } })
    expect(mockCollectTlsCertificates).toHaveBeenCalledWith(
      [{ domain: 'example.com', port: 443 }],
      {},
    )
  })

  it('forwards the timeout and concurrency the server asked for', async () => {
    await executeCommand('tls_cert_check', {
      targets: [{ domain: 'example.com', port: 8443 }],
      timeoutSeconds: 5,
      concurrency: 2,
    })

    expect(mockCollectTlsCertificates).toHaveBeenCalledWith(
      [{ domain: 'example.com', port: 8443 }],
      { timeoutMs: 5000, concurrency: 2 },
    )
  })

  it('rejects a malformed payload without opening any connection', async () => {
    const result = await executeCommand('tls_cert_check', { targets: [] })

    expect(result).toEqual({
      success: false,
      error: 'tls_cert_check requires a non-empty targets array',
    })
    expect(mockCollectTlsCertificates).not.toHaveBeenCalled()
  })

  it('rejects a batch containing a bad target rather than checking the rest', async () => {
    // A partial result would read as "these domains are fine" to whoever looks
    // at it, which is exactly the failure this feature exists to prevent.
    const result = await executeCommand('tls_cert_check', {
      targets: [{ domain: 'good.example.com' }, { domain: '' }],
    })

    expect(result.success).toBe(false)
    expect(mockCollectTlsCertificates).not.toHaveBeenCalled()
  })
})
