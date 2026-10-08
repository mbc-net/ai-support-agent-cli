import type {
  AgentChatMode,
  AgentServerConfig,
  ProjectConfigResponse,
} from '../types'

/**
 * The per-command execution context every chat-backed command needs.
 *
 * `executeCommand` resolves this once from the running agent and hands it down
 * to `executeChatCommand`, `executeE2eTest` and `executeE2eScriptFix`; the two
 * E2E executors then hand it on again when they call the chat executor.
 *
 * Each of those option types used to re-declare the same nine fields, and each
 * hand-off listed them one property at a time. **Every field is optional**, so
 * dropping a line from any of those hand-offs compiles cleanly and the command
 * simply runs without that part of its context — the "configured it but it
 * never arrived" shape. One declaration plus
 * {@link forwardAgentExecutionContext} removes both copies.
 */
export interface AgentExecutionContext {
  serverConfig?: AgentServerConfig
  activeChatMode?: AgentChatMode
  availableChatModes?: AgentChatMode[]
  agentId?: string
  projectDir?: string
  projectConfig?: ProjectConfigResponse
  mcpConfigPath?: string
  tenantCode?: string
  /**
   * The project this agent itself is bound to (agent-transport's
   * `deps.projectCode`, oneshot's env). Unlike `projectConfig` it does not
   * depend on a successful config sync, so commands that must persist results
   * under the project (e2e_test) use this — never `projectConfig` as a fallback.
   */
  projectCode?: string
  browserLocalPort?: number
}

/**
 * Copy the execution context across a call boundary.
 *
 * `overrides` is for the values the caller has already resolved for this
 * command (`executeCommand` resolves `activeChatMode` per command type). A key
 * present in `overrides` wins even when its value is `undefined`, which is what
 * the callers want: an unresolved mode must stay unresolved rather than fall
 * back to the agent-wide one.
 */
export function forwardAgentExecutionContext(
  source: AgentExecutionContext,
  overrides: Partial<AgentExecutionContext> = {},
): AgentExecutionContext {
  return {
    serverConfig: source.serverConfig,
    activeChatMode: source.activeChatMode,
    availableChatModes: source.availableChatModes,
    agentId: source.agentId,
    projectDir: source.projectDir,
    projectConfig: source.projectConfig,
    mcpConfigPath: source.mcpConfigPath,
    tenantCode: source.tenantCode,
    projectCode: source.projectCode,
    browserLocalPort: source.browserLocalPort,
    ...overrides,
  }
}
