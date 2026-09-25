/**
 * Check the target of a **direct** RDP connection (no `rdp_open.tunnel`)
 * before guacd is told to connect to it.
 *
 * :::danger 共有 guacd からの乗っ取り
 * In the Docker form one guacd (`ais-guacd`) serves every project on the host,
 * and it can reach every agent container on the `ais-rdp` network — including
 * the tunnel relays other sessions have open. A direct connection whose
 * hostname points at a relay, at loopback, at that shared network, or at a
 * link-local address (cloud metadata service) would let one project ride into
 * another's tunnel or read instance credentials. Such targets are refused.
 * :::
 *
 * Every resolved address is checked; one forbidden address refuses the whole
 * target.
 *
 * :::note 残るリスク（DNS リバインディング）
 * guacd には名前のまま渡す（証明書のホスト名検証と Kerberos を変えないため）。
 * guacd は接続時に自分で名前解決するので、検査の後に応答が変わる名前は
 * すり抜け得る。この検査は多層防御であり、他セッションの中継への入り込みは
 * 中継の合言葉（`rdp-relay-gate.ts`）が塞ぐ。
 * :::
 */

import { promises as dns } from 'dns'
import * as net from 'net'
import * as os from 'os'

import { canonicalIpAddress } from '../utils/ip-address'
import { listActiveRelayAddresses } from './rdp-relay-registry'
import { RdpOpenRefusedError } from './rdp-session-registry'
import { resolveRdpTunnelListenMode, type RdpTunnelListenMode } from './rdp-tunnel-support'

/** Refusal of a direct target. Reported with the `error` (fatal) contract. */
export class RdpDirectTargetForbiddenError extends RdpOpenRefusedError {
  constructor(detail: string) {
    super(`direct_target_forbidden: ${detail}`)
    this.name = 'RdpDirectTargetForbiddenError'
  }
}

export interface DirectTargetDeps {
  lookupAll?: (host: string) => Promise<{ address: string; family: number }[]>
  /** Relay listen mode; `docker-network` adds the shared guacd network to the refusals. */
  listenMode?: RdpTunnelListenMode
  /** guacd's host, needed to find the shared network in the Docker form. */
  guacdHost?: string
  networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
  relayAddresses?: () => Iterable<string>
}

/** Always-refused ranges, with the label used in the refusal. */
const STATIC_RANGES: { network: string; prefix: number; family: 'ipv4' | 'ipv6'; label: string }[] = [
  { network: '127.0.0.0', prefix: 8, family: 'ipv4', label: 'a loopback address' },
  { network: '0.0.0.0', prefix: 8, family: 'ipv4', label: 'an unspecified address' },
  { network: '169.254.0.0', prefix: 16, family: 'ipv4', label: 'a link-local address' },
  { network: '::1', prefix: 128, family: 'ipv6', label: 'a loopback address' },
  { network: '::', prefix: 128, family: 'ipv6', label: 'an unspecified address' },
  { network: 'fe80::', prefix: 10, family: 'ipv6', label: 'a link-local address' },
]

/** IPv4-mapped IPv6 (any spelling) compares as its IPv4 address. */
const canonical = canonicalIpAddress

function familyOf(address: string): 'ipv4' | 'ipv6' {
  return net.isIPv4(address) ? 'ipv4' : 'ipv6'
}

function inRange(address: string, network: string, prefix: number, family: 'ipv4' | 'ipv6'): boolean {
  if (familyOf(address) !== family) return false
  const list = new net.BlockList()
  list.addSubnet(network, prefix, family)
  return list.check(address, family)
}

/** The CIDR of this host's interface that contains `peer` (the shared guacd network). */
function networkContaining(
  peer: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): { network: string; prefix: number } | null {
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || !info.cidr) continue
      const prefix = Number(info.cidr.split('/')[1])
      if (inRange(peer, info.address, prefix, 'ipv4')) {
        return { network: networkAddress(info.address, prefix), prefix }
      }
    }
  }
  return null
}

function networkAddress(address: string, prefix: number): string {
  const n = address.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const net4 = (n & mask) >>> 0
  return [24, 16, 8, 0].map((shift) => (net4 >>> shift) & 0xff).join('.')
}

/**
 * Resolve `hostname` and refuse it when any address is forbidden.
 *
 * @returns the first resolved address (informational; guacd gets the name)
 * @throws {RdpDirectTargetForbiddenError}
 */
export async function checkDirectRdpTarget(
  hostname: string,
  deps: DirectTargetDeps = {},
): Promise<string> {
  if (!hostname) throw new RdpDirectTargetForbiddenError('hostname is required')
  const lookupAll =
    deps.lookupAll ?? ((host: string) => dns.lookup(host, { all: true, verbatim: true }))
  const listenMode = 'listenMode' in deps ? deps.listenMode : resolveRdpTunnelListenMode()
  const relayAddresses = new Set(
    [...(deps.relayAddresses ?? listActiveRelayAddresses)()].map(canonical),
  )

  let addresses: string[]
  try {
    addresses = (await lookupAll(hostname)).map((a) => canonical(a.address))
  } catch {
    // The resolver's message is not needed and may be noisy; the name is.
    throw new RdpDirectTargetForbiddenError(`could not resolve ${hostname}`)
  }
  if (addresses.length === 0) {
    throw new RdpDirectTargetForbiddenError(`could not resolve ${hostname}`)
  }

  let guacdNetwork: { network: string; prefix: number } | null = null
  if (listenMode === 'docker-network') {
    try {
      const guacd = (await lookupAll(deps.guacdHost ?? '')).map((a) => canonical(a.address))
      const guacdV4 = guacd.find((a) => net.isIPv4(a))
      guacdNetwork = guacdV4
        ? networkContaining(guacdV4, (deps.networkInterfaces ?? os.networkInterfaces)())
        : null
    } catch {
      guacdNetwork = null
    }
    // Fail closed: without the shared network the check would be incomplete.
    if (!guacdNetwork) {
      throw new RdpDirectTargetForbiddenError(
        `could not determine the guacd network to check ${hostname} against`,
      )
    }
  }

  for (const address of addresses) {
    for (const range of STATIC_RANGES) {
      if (inRange(address, range.network, range.prefix, range.family)) {
        throw new RdpDirectTargetForbiddenError(`${hostname} resolves to ${address}, ${range.label}`)
      }
    }
    if (relayAddresses.has(address)) {
      throw new RdpDirectTargetForbiddenError(
        `${hostname} resolves to ${address}, where an RDP tunnel relay is listening`,
      )
    }
    if (guacdNetwork && inRange(address, guacdNetwork.network, guacdNetwork.prefix, 'ipv4')) {
      throw new RdpDirectTargetForbiddenError(
        `${hostname} resolves to ${address}, inside the guacd network ${guacdNetwork.network}/${guacdNetwork.prefix}`,
      )
    }
  }
  return addresses[0]
}
