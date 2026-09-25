import {
  AGENT_CAPABILITY_DETAIL_MAX_LENGTH,
  AGENT_CAPABILITY_KEYS,
  type AgentCapabilityDeclaration,
  type AgentCapabilityKey,
  type AgentEffectiveCapability,
} from '../types'
import type { RdpTunnelKind } from '../rdp/rdp-tunnel-message'
import { detectRdpTunnelKinds } from '../rdp/rdp-tunnel-support'
import { getCapabilityApplyFailures } from './capability-apply-failures'
import {
  detectAgentRuntime,
  isCapabilityAlreadyWired,
  resolveCapabilityApplyClass,
} from './capability-plan'
import {
  computeCapabilityDeclarationHash,
  resolveCliCapabilityFlags,
  resolveEffectiveCapability,
} from './capability-resolver'

/**
 * Turning the declaration plus this runtime's facts into what the API is told.
 *
 * Two readers, two functions:
 *
 * - {@link planCapability} — what the runtime *allows*. The RDP gate uses this,
 *   so that a previous failure never permanently refuses a connection the user
 *   is asking for again.
 * - {@link describeCapability} — the same, with any recorded apply failure laid
 *   on top. This is what the heartbeat reports, because "tried and failed" is a
 *   different next action for the user than "waiting on a restart".
 */

export interface CapabilityContext {
  /** Declaration delivered by the server. `undefined` = nothing declared. */
  declaration?: AgentCapabilityDeclaration
  /**
   * Start-up flags. Defaults to reading them out of `env`; pass explicitly only
   * to test the composition itself.
   */
  cliFlags?: AgentCapabilityDeclaration
  env?: NodeJS.ProcessEnv
  /** Defaults to the process-wide record. */
  applyFailures?: Partial<Record<AgentCapabilityKey, string>>
  /**
   * RDP tunnel routes this process serves; `undefined` = not configured.
   * Defaults to {@link detectRdpTunnelKinds} over `env`.
   */
  detectRdpTunnels?: (env: NodeJS.ProcessEnv) => RdpTunnelKind[] | undefined
}

/**
 * Runtime-derived state of one capability, ignoring any recorded failure.
 *
 * Returns `undefined` when the capability is not effective at all — neither
 * declared nor flagged. The API renders a key missing from the reported array
 * as `inactive`.
 */
export function planCapability(
  key: AgentCapabilityKey,
  ctx: CapabilityContext = {},
): AgentEffectiveCapability | undefined {
  const env = ctx.env ?? process.env
  const cliFlags = ctx.cliFlags ?? resolveCliCapabilityFlags(env)
  const decision = resolveEffectiveCapability(key, ctx.declaration, cliFlags)
  if (!decision.effective) return undefined

  // Narrowed to a reportable source by the guard above: a capability nothing
  // enabled is never reported, so `source: 'none'` cannot be assembled here.
  const source = decision.source
  const declarationHash = computeCapabilityDeclarationHash(ctx.declaration)

  if (isCapabilityAlreadyWired(key, env)) {
    return { key, state: 'active', source, declarationHash }
  }

  const applyClass = resolveCapabilityApplyClass(key, detectAgentRuntime(env))
  switch (applyClass) {
    case 'immediate':
      return { key, state: 'active', source, declarationHash }
    case 'restart':
      return {
        key,
        state: 'not_applied',
        reason: 'action_required_restart',
        source,
        declarationHash,
        detail:
          'Applied when the container is recreated: guacd network membership ' +
          'and GUACD_HOST are fixed at `docker run` time.',
      }
    case 'redeploy':
      return {
        key,
        state: 'not_applied',
        reason: 'action_required_redeploy',
        source,
        declarationHash,
        detail:
          'Needs a regenerated manifest with the guacd sidecar. A sidecar ' +
          'cannot be added to a running Pod or task, and neither the API nor ' +
          'the agent writes to your cluster.',
      }
  }
}

/**
 * The heartbeat's view: {@link planCapability} plus any recorded failure, plus
 * — for an active `rdp` — the tunnel routes this process serves.
 */
export function describeCapability(
  key: AgentCapabilityKey,
  ctx: CapabilityContext = {},
): AgentEffectiveCapability | undefined {
  const planned = planCapability(key, ctx)
  if (!planned) return undefined

  const failure = (ctx.applyFailures ?? getCapabilityApplyFailures())[key]
  if (failure === undefined) return withRdpTunnels(planned, ctx)

  return {
    ...planned,
    state: 'not_applied',
    reason: 'apply_failed',
    detail: failure.slice(0, AGENT_CAPABILITY_DETAIL_MAX_LENGTH),
  }
}

/**
 * Attach `rdpTunnels` to an active `rdp` entry (contract 2).
 *
 * Only for `active`: listing routes on an entry that cannot be used would let
 * the API read "usable" into it. Omitted entirely when tunnels are not
 * configured, so the API treats this agent like one that predates tunnels.
 */
function withRdpTunnels(
  entry: AgentEffectiveCapability,
  ctx: CapabilityContext,
): AgentEffectiveCapability {
  if (entry.key !== 'rdp' || entry.state !== 'active') return entry
  const env = ctx.env ?? process.env
  const detect = ctx.detectRdpTunnels ?? ((e: NodeJS.ProcessEnv) => detectRdpTunnelKinds({ env: e }))
  const kinds = detect(env)
  return kinds ? { ...entry, rdpTunnels: kinds } : entry
}

/**
 * Every effective capability, for the heartbeat body.
 *
 * **Always returns an array, possibly empty.** Sending no array at all is how
 * an agent too old to report is recognised (`unknown`, treated fail-closed);
 * an empty array means "reported, and nothing is on".
 */
export function buildCapabilityReport(
  ctx: CapabilityContext = {},
): AgentEffectiveCapability[] {
  const report: AgentEffectiveCapability[] = []
  for (const key of AGENT_CAPABILITY_KEYS) {
    const entry = describeCapability(key, ctx)
    if (entry) report.push(entry)
  }
  return report
}

/**
 * Whether the capability can be used right now.
 *
 * Deliberately built on {@link planCapability}: a recorded apply failure must
 * not permanently refuse a connection the user is explicitly asking for again.
 */
export function isCapabilityActive(
  key: AgentCapabilityKey,
  ctx: CapabilityContext = {},
): boolean {
  return planCapability(key, ctx)?.state === 'active'
}
