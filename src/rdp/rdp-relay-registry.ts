/**
 * Addresses the RDP tunnel relays of this process are listening on.
 *
 * Read by the direct-connection target check (`rdp-direct-target.ts`): a
 * direct `rdp_open` must never be pointed at a relay, or it would ride another
 * session's tunnel. Counted, because two relays can share a bind address.
 */

const active = new Map<string, number>()

export function registerRelayAddress(address: string): () => void {
  active.set(address, (active.get(address) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (active.get(address) ?? 1) - 1
    if (count <= 0) active.delete(address)
    else active.set(address, count)
  }
}

export function listActiveRelayAddresses(): string[] {
  return [...active.keys()]
}
