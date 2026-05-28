import { getLocalIpAddress, getSystemInfo } from '../src/system-info'

jest.mock('os', () => {
  const actual = jest.requireActual('os')
  return {
    ...actual,
    networkInterfaces: jest.fn(actual.networkInterfaces),
  }
})

import * as os from 'os'

const mockedNetworkInterfaces = os.networkInterfaces as jest.MockedFunction<typeof os.networkInterfaces>

describe('system-info', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('getSystemInfo', () => {
    it('should return system info with expected fields', () => {
      const info = getSystemInfo()
      expect(info).toHaveProperty('platform')
      expect(info).toHaveProperty('arch')
      expect(typeof info.cpuUsage).toBe('number')
      expect(typeof info.memoryUsage).toBe('number')
      expect(typeof info.uptime).toBe('number')
      // diskUsagePercent は number または undefined のいずれか（環境依存）
      if (info.diskUsagePercent !== undefined) {
        expect(typeof info.diskUsagePercent).toBe('number')
        expect(info.diskUsagePercent).toBeGreaterThanOrEqual(0)
        expect(info.diskUsagePercent).toBeLessThanOrEqual(100)
      }
    })
  })

  describe('getLocalIpAddress', () => {
    it('should return an IPv4 address when external interface exists', () => {
      mockedNetworkInterfaces.mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: 'aa:bb:cc:dd:ee:ff',
            internal: false,
            cidr: '192.168.1.100/24',
          },
        ],
      })

      const ip = getLocalIpAddress()
      expect(ip).toBe('192.168.1.100')
    })

    it('should return undefined when no external IPv4 interfaces exist', () => {
      mockedNetworkInterfaces.mockReturnValue({
        lo0: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
      })

      const ip = getLocalIpAddress()
      expect(ip).toBeUndefined()
    })

    it('should return undefined when networkInterfaces returns empty object', () => {
      mockedNetworkInterfaces.mockReturnValue({})

      const ip = getLocalIpAddress()
      expect(ip).toBeUndefined()
    })

    it('should skip IPv6 interfaces', () => {
      mockedNetworkInterfaces.mockReturnValue({
        en0: [
          {
            address: 'fe80::1',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: 'aa:bb:cc:dd:ee:ff',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 1,
          },
        ],
      })

      const ip = getLocalIpAddress()
      expect(ip).toBeUndefined()
    })
  })
})

describe('getDiskUsagePercent', () => {
  const { getDiskUsagePercent } = require('../src/system-info') as typeof import('../src/system-info')
  const fs = require('fs') as typeof import('fs')

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('returns a percentage when fs.statfsSync is available', () => {
    if (typeof (fs as unknown as { statfsSync?: unknown }).statfsSync !== 'function') {
      // Node < 18.15: skip
      return
    }
    const result = getDiskUsagePercent('/tmp')
    expect(typeof result).toBe('number')
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThanOrEqual(100)
  })

  it('returns undefined if statfsSync throws', () => {
    const orig = (fs as unknown as { statfsSync?: (p: string) => unknown }).statfsSync
    if (typeof orig !== 'function') return
    jest
      .spyOn(fs as unknown as { statfsSync: (p: string) => unknown }, 'statfsSync')
      .mockImplementation(() => {
        throw new Error('ENOENT')
      })
    const result = getDiskUsagePercent('/nonexistent')
    expect(result).toBeUndefined()
  })

  it('returns undefined when statfsSync is not available (Node < 18.15)', () => {
    // Simulate environment where statfsSync does not exist
    const fsObj = fs as unknown as Record<string, unknown>
    const original = fsObj.statfsSync
    delete fsObj.statfsSync
    try {
      const result = getDiskUsagePercent('/tmp')
      expect(result).toBeUndefined()
    } finally {
      if (original !== undefined) {
        fsObj.statfsSync = original
      }
    }
  })

  it('returns undefined when statfsSync returns blocks <= 0', () => {
    const fsObj = fs as unknown as Record<string, unknown>
    const original = fsObj.statfsSync
    fsObj.statfsSync = () => ({ blocks: 0, bfree: 0, bavail: 0 })
    try {
      const result = getDiskUsagePercent('/tmp')
      expect(result).toBeUndefined()
    } finally {
      fsObj.statfsSync = original
    }
  })

  it('returns undefined when statfsSync returns null', () => {
    const fsObj = fs as unknown as Record<string, unknown>
    const original = fsObj.statfsSync
    fsObj.statfsSync = () => null
    try {
      const result = getDiskUsagePercent('/tmp')
      expect(result).toBeUndefined()
    } finally {
      fsObj.statfsSync = original
    }
  })
})

describe('getSystemInfo with disk warning', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('emits a warning when disk usage exceeds threshold', () => {
    const fs = require('fs') as typeof import('fs')
    const fsObj = fs as unknown as Record<string, unknown>
    const original = fsObj.statfsSync

    // Simulate 95% disk usage: blocks=100, bfree=5 → used=95/100=95%
    fsObj.statfsSync = () => ({ blocks: 100, bfree: 5, bavail: 5 })

    // Use jest.resetModules to get a fresh module with lastDiskUsageWarnAt = 0
    jest.resetModules()
    // Re-mock logger so we can spy on it
    jest.mock('../src/logger')
    const { getSystemInfo: freshGetSystemInfo } = require('../src/system-info') as typeof import('../src/system-info')
    const { logger: freshLogger } = require('../src/logger') as typeof import('../src/logger')

    try {
      freshGetSystemInfo()
      expect(freshLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Disk usage on'),
      )
    } finally {
      fsObj.statfsSync = original
    }
  })

  it('suppresses repeated disk warning within 10 minutes', () => {
    const fs = require('fs') as typeof import('fs')
    const fsObj = fs as unknown as Record<string, unknown>
    const original = fsObj.statfsSync

    fsObj.statfsSync = () => ({ blocks: 100, bfree: 5, bavail: 5 })

    jest.resetModules()
    jest.mock('../src/logger')
    const { getSystemInfo: freshGetSystemInfo } = require('../src/system-info') as typeof import('../src/system-info')
    const { logger: freshLogger } = require('../src/logger') as typeof import('../src/logger')

    try {
      freshGetSystemInfo()
      ;(freshLogger.warn as jest.Mock).mockClear()
      // Second call within 10 minutes should NOT emit another warning
      freshGetSystemInfo()
      expect(freshLogger.warn).not.toHaveBeenCalled()
    } finally {
      fsObj.statfsSync = original
    }
  })
})

describe('getLocalIpAddress with null interface entries', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('should skip interface keys that return null/undefined entries', () => {
    // The ?? [] fallback in getLocalIpAddress covers the case where an interface entry is undefined
    mockedNetworkInterfaces.mockReturnValue({
      lo0: undefined as unknown as os.NetworkInterfaceInfo[],
      en0: [
        {
          address: '10.0.0.1',
          netmask: '255.255.255.0',
          family: 'IPv4',
          mac: 'aa:bb:cc:dd:ee:ff',
          internal: false,
          cidr: '10.0.0.1/24',
        },
      ],
    })

    const ip = getLocalIpAddress()
    expect(ip).toBe('10.0.0.1')
  })
})
