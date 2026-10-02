import { ENV_VARS } from '../constants'
import type { AgentCapabilityKey } from '../types'
import { isRunningOnKubernetes } from '../utils/container-runtime'

/**
 * Deciding *when* a declared capability can take effect in this process.
 *
 * The three classes below are not preferences — they are facts about what each
 * runtime allows. Reporting the wrong one leaves the admin UI telling the user
 * to do something that will not help (or, worse, offering a connection that
 * cannot succeed).
 */

/** Execution form of this agent process. */
export type AgentRuntime = 'host' | 'docker' | 'k8s' | 'ecs'

/**
 * - `immediate`: applied without restarting the process.
 * - `restart`: needs the container to be recreated (env vars and network
 *   membership are fixed at `docker run` time).
 * - `redeploy`: needs a new Pod / TaskDefinition; a sidecar cannot be added to
 *   a running workload. **Neither the api nor the agent writes to the
 *   customer's cluster**, so the agent never performs this itself.
 */
export type CapabilityApplyClass = 'immediate' | 'restart' | 'redeploy'

/**
 * Detect the execution form from the environment.
 *
 * 判定順序には意味がある。Kubernetes / ECS の判定を `AI_SUPPORT_AGENT_IN_DOCKER`
 * より先に置くのは、オーケストレータ上のワークロードには「ホスト側の
 * DockerSupervisor がコンテナを作り直す」という前提が無いためである
 * （`self-update-capability.ts` が自己更新の可否判定で採っている順序と同じ）。
 * 誤って `docker` と判定すると「再起動すれば適用されます」と案内してしまい、
 * 実際には何をしても適用されない。
 *
 * 材料はいずれも既存の仕組みから採っている。
 * - `KUBERNETES_SERVICE_HOST`: `utils/container-runtime.ts` の共有ヘルパ
 * - `ECS_CONTAINER_METADATA_URI_V4`: `replica-identity.ts` が ECS タスク ID の
 *   導出に使っているのと同じ変数
 * - `AI_SUPPORT_AGENT_IN_DOCKER`: `utils.ts` の `isInDocker()` と同じ変数
 */
export function detectAgentRuntime(
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntime {
  if (isRunningOnKubernetes(env)) return 'k8s'
  if (env.ECS_CONTAINER_METADATA_URI_V4) return 'ecs'
  if (env[ENV_VARS.IN_DOCKER] === '1') return 'docker'
  return 'host'
}

/**
 * Apply class for one capability in one runtime.
 *
 * `rdp` is the only key today and its class depends purely on the runtime:
 *
 * - **host** — `guacd` は接続要求時に遅延起動できる（`guacd-runtime.ts`）。
 *   接続時に読まれるのは `GUACD_HOST` / `GUACD_PORT` だけなので、起動後に用意して
 *   環境変数を書き換えれば次の接続から成立する。
 * - **docker** — guacd への到達にはコンテナのネットワーク所属と環境変数が要り、
 *   どちらも `docker run` 時にしか渡せない。稼働中のコンテナの環境変数は変えられず、
 *   エージェント本体はそのコンテナの中にいる。
 * - **k8s / ecs** — サイドカーは Pod / TaskDefinition の宣言であり、実行中の
 *   ワークロードに足す手段が存在しない。
 */
export function resolveCapabilityApplyClass(
  _key: AgentCapabilityKey,
  runtime: AgentRuntime,
): CapabilityApplyClass {
  switch (runtime) {
    case 'host':
      return 'immediate'
    case 'docker':
      return 'restart'
    case 'k8s':
    case 'ecs':
      return 'redeploy'
  }
}

/**
 * Whether the capability is already wired up in this environment, so that no
 * apply step remains regardless of the runtime's apply class.
 *
 * For `rdp` that means a reachable guacd endpoint is already configured: the
 * sidecar in a generated K8s / ECS manifest, the container the host-side CLI
 * started and pointed this one at, or an endpoint the operator runs themselves.
 *
 * Without this check a Pod that *does* have the guacd sidecar would still report
 * `not_applied(action_required_redeploy)`, and the admin UI would withdraw the
 * connection from a deployment where RDP demonstrably works.
 */
export function isCapabilityAlreadyWired(
  key: AgentCapabilityKey,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (key) {
    case 'rdp':
      return Boolean(env.GUACD_HOST)
  }
}
