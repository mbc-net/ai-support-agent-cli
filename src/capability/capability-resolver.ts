import { createHash } from 'crypto'

import { ENV_VARS } from '../constants'
import {
  AGENT_CAPABILITY_KEYS,
  type AgentCapabilityDeclaration,
  type AgentCapabilityKey,
  type ReportedCapabilitySource,
} from '../types'

/**
 * Composing the project's capability declaration with the operator's start-up
 * flags.
 *
 * :::danger これはフォールバックではなく 2 入力の合成である
 * このリポジトリには**フォールバック禁止ルール**がある。「新しい仕組みを入れたら、
 * 旧データからのフォールバックを実装してはならない」というものだ。ここで行う OR
 * 合成はそれに**該当しない**。
 *
 * フォールバックとは「新しい経路に値が無いときに、旧経路の値を代わりに読む」ことで
 * あり、値の出所が隠れるために禁じている。ここで扱う CLI フラグは旧データではなく、
 * **エージェントを起動した運用者が明示した現在の意思**である。宣言とフラグは並立する
 * 2 つの入力であり、どちらも「この capability を有効にせよ」という同じ向きの指示で
 * ある。OR で合成しても「どちらが効いているか分からない」は起きない（どちらでも
 * 有効になるため）。根拠は {@link CapabilitySource} として報告に残す。
 *
 * 逆に、宣言が無いことを理由に `--rdp` を打ち消してはならない。すでに `--rdp` で
 * 運用しているホストが、api 側の設定を触っていないというだけで**無言で RDP を
 * 失う**。これは capability 管理の導入が既存の稼働を壊す唯一の経路である。
 * :::
 */

/**
 * Which of the two inputs turned the capability on.
 *
 * `'none'` is the resolver's own answer for "neither input enabled it"; it is
 * **not** reportable, which is why {@link ReportedCapabilitySource} — the type
 * the heartbeat carries — excludes it.
 */
export type CapabilitySource = 'none' | ReportedCapabilitySource

/**
 * Discriminated on `effective` so that `'none'` cannot reach a report.
 *
 * A caller that has ruled out `effective === false` gets a `source` narrowed to
 * {@link ReportedCapabilitySource}; assembling a report from a non-effective
 * decision therefore fails to compile rather than shipping `source: 'none'` to
 * the API.
 */
export type EffectiveCapabilityDecision =
  | { effective: true; source: ReportedCapabilitySource }
  | { effective: false; source: 'none' }

/**
 * Compose the two inputs for one capability.
 *
 * An explicit `false` on either side means only "this side is off"; it never
 * cancels the other side.
 */
export function resolveEffectiveCapability(
  key: AgentCapabilityKey,
  declaration: AgentCapabilityDeclaration | undefined,
  cliFlags: AgentCapabilityDeclaration | undefined,
): EffectiveCapabilityDecision {
  const declared = declaration?.[key] === true
  const flagged = cliFlags?.[key] === true
  if (declared && flagged) return { effective: true, source: 'both' }
  if (declared) return { effective: true, source: 'declared' }
  if (flagged) return { effective: true, source: 'flag' }
  return { effective: false, source: 'none' }
}

/**
 * The operator's start-up instruction, as it reaches **this** process.
 *
 * One instruction, three carriers — because `--rdp` is given to whatever starts
 * the agent, which is not always the process that ends up relaying RDP:
 *
 * | Runtime | Who got `--rdp` | What this process can see |
 * |---|---|---|
 * | host | this process (or its parent, before `fork`) | `AI_SUPPORT_AGENT_RDP=1` |
 * | Docker | the host-side CLI | `GUACD_HOST`, injected by `buildGuacdDockerArgs` |
 * | K8s / ECS | `manifest … --rdp` | `GUACD_HOST`, set beside the guacd sidecar |
 *
 * Reading `GUACD_HOST` as the same instruction is not a fallback to legacy data:
 * in those runtimes it is the *only* form the instruction can take, and it is
 * put there by this very codebase precisely because `--rdp` was given. Ignoring
 * it would report `inactive` for container deployments where RDP demonstrably
 * works today — the silent loss the danger note above forbids.
 */
export function resolveCliCapabilityFlags(
  env: NodeJS.ProcessEnv = process.env,
): AgentCapabilityDeclaration {
  const flags: AgentCapabilityDeclaration = {}
  if (env[ENV_VARS.RDP] === '1' || Boolean(env.GUACD_HOST)) {
    flags.rdp = true
  }
  return flags
}

/**
 * Length of the hash returned by {@link computeCapabilityDeclarationHash}.
 * Well under the API's 64-character limit; the value only has to distinguish
 * declarations from one another, not resist collisions from an attacker.
 */
const DECLARATION_HASH_LENGTH = 16

/**
 * Hash of the declaration **alone**.
 *
 * :::danger 配信設定全体の `configHash` を流用しない
 * api は設定同期のために `configHash` を計算しているが、それは配信する設定そのもの
 * （共有ファイルのリビジョン、環境変数、CLAUDE.md …）から作られる。これを capability
 * の適用判定に流用すると、capability と無関係な設定変更のたびにハッシュが変わり、
 * **そのたびに（Docker 形態では）エージェントが再起動する**。稼働中のチャット・
 * ターミナル・RDP セッションが定期的に切れる、原因の見えない不安定さになる。
 * :::
 *
 * 正規化の要点は 2 つ。
 *
 * - 許可リスト（{@link AGENT_CAPABILITY_KEYS}）のキーだけを見る。別経路で書き込まれた
 *   未知のキーで適用判定が揺れないようにする。
 * - **未設定と `false` を同じ値に畳む**。区別すると、画面で ON → OFF した直後に
 *   ハッシュが振動し、適用済みマーカーが無意味になる。
 */
export function computeCapabilityDeclarationHash(
  declaration: AgentCapabilityDeclaration | undefined,
): string {
  const normalized = [...AGENT_CAPABILITY_KEYS]
    .sort()
    .filter((key) => declaration?.[key] === true)
    .join(',')
  return createHash('sha256')
    .update(normalized)
    .digest('hex')
    .slice(0, DECLARATION_HASH_LENGTH)
}
