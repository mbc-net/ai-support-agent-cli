import * as net from 'net'

/**
 * Canonical form of an IP address for comparisons.
 *
 * An IPv4-mapped IPv6 address (`::ffff:0:0/96`) is the IPv4 address it maps:
 * `::ffff:127.0.0.1`, `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:1` all become
 * `127.0.0.1`. Matching only the dotted spelling let the hexadecimal ones
 * slip past address checks.
 *
 * Anything that is not an IPv6 address is returned unchanged.
 */
export function canonicalIpAddress(address: string | undefined): string {
  if (!address) return ''
  if (!net.isIPv6(address)) return address
  const hextets = expandIpv6(address)
  if (hextets === null) return address
  const mapped =
    hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff
  if (!mapped) return address
  return [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff].join('.')
}

/** Eight 16-bit groups of a (valid) IPv6 address, dotted IPv4 tail included. */
function expandIpv6(address: string): number[] | null {
  let text = address.toLowerCase()
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const octets = dotted[1].split('.').map(Number)
    text =
      text.slice(0, dotted.index) +
      `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
  }
  const halves = text.split('::')
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((h) => parseInt(h, 16))
  const head = parse(halves[0])
  const tail = halves.length > 1 ? parse(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}
