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
