import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ApiClient } from './api-client'
import { AlertProcessor } from './alert-processor'
import { AppSyncSubscriber } from './appsync-subscriber'
import { type ConfigSyncDeps, type ConfigSyncState, performConfigSync, performSetup, performSyncRepository, refreshChatMode } from './agent-config-sync'
import type { RepoSyncResult } from './repo-sync'
import { type TransportDeps, type TransportState, startSubscriptionMode, startHeartbeat, startTerminalWebSocket, startVsCodeTunnel, stopTransport } from './agent-transport'
import {
  AGENT_VERSION,
  ALERT_STALE_PROCESSING_MINUTES,
  ALERT_STALE_RECOVERY_INTERVAL_MS,
  DELAYED_RESTART_MS,
  DOCKER_MARKER_BUILT_HASH,
  DOCKER_MARKER_CUSTOMIZATION_HASH,
  DOCKER_MARKER_REBUILD_NEEDED,
  DOCKER_MARKER_REGISTERED_AGENT_ID,
  DOCKER_RESTART_EXIT_CODE,
  DOCKER_UPDATE_EXIT_CODE,
  INITIAL_CONFIG_SYNC_MAX_RETRIES,
  INITIAL_CONFIG_SYNC_RETRY_DELAY_MS,
  REGISTER_AUTH_ERROR_DELAY_MS,
  REGISTER_RETRY_BASE_DELAY_MS,
  REGISTER_RETRY_MAX_DELAY_MS,
  REPLICA_STANDBY_RETRY_DELAY_MS,
  SERVER_SETUP_CUSTOM_TASKS_CAPABILITY,
  SHUTDOWN_DRAIN_POLL_INTERVAL_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
} from './constants'
import { calculateBackoff } from './retry-strategy'
import { getConfigDir } from './config-manager'
import { detectEcsLauncherCapability } from './ecs/launcher-capability'
import { t } from './i18n'
import { logger } from './logger'
import { initProjectDir } from './project-dir'
import { getLocalIpAddress } from './system-info'
import {
  PENDING_RESULT_MIN_RETRY_AGE_MS,
  startPendingResultFlush,
  submitPendingResults,
} from './pending-result-store'
import type { TransportKind } from './ipc-types'
import type { AdmissionMode, AdmissionResult, AgentChatMode, ProjectRegistration, RegisterResponse } from './types'
import { generateProjectDockerfile } from './docker/docker-runner'
import { detectChannelFromVersion, detectInstallMethod, isNewerVersion, performUpdate, reExecProcess } from './update-checker'
import { describeSelfUpdateBlockReason, resolveSelfUpdateCapability } from './self-update-capability'
import { getUpdateVersionFilePath } from './utils/path-utils'
import { atomicWriteFile, getErrorMessage, isAuthenticationError, isInDocker, resolveUrlForDocker, sleep } from './utils'
import { readMarkerFile } from './utils/marker-file'

export interface ProjectAgentOptions {
  pollInterval: number
  heartbeatInterval: number
}

export class ProjectAgent {
  private readonly client: ApiClient
  private prefix: string
  private tenantCode: string
  private projectDir: string | undefined
  private readonly apiUrl: string
  private token: string
  private projectCode: string

  private readonly configSyncState: ConfigSyncState = {
    currentConfigHash: undefined,
    projectConfig: undefined,
    serverConfig: null,
    availableChatModes: [],
    activeChatMode: undefined,
    activeChatModeExplicit: false,
    mcpConfigPath: undefined,
    dockerCustomizationHash: undefined, // will be initialized in constructor from docker-built-hash
  }

  private configSyncDeps: ConfigSyncDeps

  private readonly transportState: TransportState = {
    heartbeatTimer: null,
    subscriber: null,
    terminalWs: null,
    vsCodeWs: null,
    configSyncDebounceTimer: null,
    authRejectedTransports: new Set(),
    inFlightCommands: new Set(),
    draining: false,
  }

  private transportDeps: TransportDeps

  // Persistent registration loop state. start() spawns a loop that retries
  // register() forever with exponential backoff so a transient network outage
  // does not leave the agent in a silent zombie state.
  private isRegistering = false
  private registerLoopCancelled = false
  private registerAttempt = 0
  private registerAbortController: AbortController | null = null
  /** In-flight register loop, awaited by restartRegisterLoop() before restarting. */
  private registerLoopPromise: Promise<void> | null = null
  /** Incremented on every stop() so a deferred restart can detect a later stop. */
  private stopGeneration = 0
  /**
   * Admission mode for the next register call.
   *
   * `'initial'` normally. Set to `'standby'` by eviction recovery: a replica
   * that was evicted must NOT re-register as `'initial'`, because the server
   * treats `'initial'` as "you may evict the oldest live replica" — the evicted
   * replica would evict whoever took its slot, that one would do the same, and
   * the two would swap forever (ping-pong). Sticky across register retries so a
   * transient failure between eviction and re-admission cannot silently
   * downgrade it back to `'initial'`.
   */
  private nextAdmissionMode: AdmissionMode = 'initial'
  /** Resolver that cuts the standby wait short (set only while parked). */
  private standbyWakeup: (() => void) | null = null
  // Edge-triggered logging: warn only when the failure mode changes or recovers,
  // and emit debug for the noisy intermediate retries. Patterned on Zabbix's
  // "started to fail" / "is working again" log pair.
  private lastRegisterError: { isAuth: boolean; message: string } | null = null
  private alertPollingTimer: ReturnType<typeof setInterval> | null = null
  private alertStaleRecoveryTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Retries results that failed to reach the API (see `startPendingResultFlush`).
   * Without this the retry only ran at process start, so a result orphaned by an
   * API deployment sat on disk until the agent happened to restart.
   */
  private pendingResultFlushTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Whether the unconditional start-up recovery has already run.
   *
   * `registerAndStart()` runs again on token update and on eviction → re-admission,
   * and `stopTransport` deliberately does NOT clear `inFlightCommands` — commands
   * already running survive a transport restart. So on a re-registration a result
   * may be mid-submit on the main path, and sweeping it up unconditionally would
   * re-introduce the parallel double-POST that PENDING_RESULT_MIN_RETRY_AGE_MS exists
   * to prevent. Only the very first registration is guaranteed to have nothing in flight.
   */
  private hasRecoveredPendingResults = false

  // Graceful shutdown (phase 3 of the replica lifecycle plan).
  /**
   * Guards shutdown() against double-invocation (e.g. SIGTERM+SIGINT both
   * firing, or the auto-updater's stopAllAgents racing a signal handler).
   * Kept as a plain boolean (flipped true synchronously by the first call,
   * alongside `shutdownPromise` below) because several call sites
   * (`handleEviction()`, `updateToken()`) only need a synchronous "is a
   * shutdown in progress" check, not the in-flight promise itself.
   */
  private shuttingDown = false
  /**
   * The in-flight `doShutdown()` promise, once a first `shutdown()` call has
   * started one. `shutdown()` is a thin memoizing wrapper around
   * `doShutdown()`: a second concurrent caller joins (awaits) this same
   * promise instead of getting an instant no-op — see `shutdown()`'s doc
   * comment for why an early-return no-op is wrong here (it would let a
   * second caller like the auto-updater proceed as if the drain/release had
   * already finished, while the first caller's drain of a genuinely
   * in-flight command is still running).
   */
  private shutdownPromise: Promise<void> | null = null
  /**
   * Whether this replica currently holds an admitted slot. Set true as soon
   * as `register()`/`performRegistration()` reports `admission.accepted`
   * (i.e. as soon as the server-side truth is known — see `registerAndStart`),
   * set false again by handleEviction(). shutdown() skips releaseSelf() when
   * this is false — a replica that was rejected/evicted holds nothing to
   * release.
   */
  private slotHeld = false
  /**
   * Command ids that must not count as "still in flight" for
   * `waitForDrain()`'s purposes, because they are themselves the command
   * driving the current shutdown (reboot/update/docker-rebuild) and cannot be
   * removed from `transportState.inFlightCommands` until the very `shutdown()`
   * call they triggered resolves — see `shutdown()`'s doc comment.
   *
   * A `Set` rather than a single captured value: `shutdown()` adds to this set
   * *before* checking/returning the memoized `shutdownPromise`, so a caller
   * that joins an already-in-flight shutdown (e.g. `performReboot()` calling
   * `shutdown({ excludeCommandId })` after a plain SIGTERM-triggered
   * `shutdown()` already started the drain) still gets its exclusion honored.
   * A single opts-snapshot captured only by the first caller would silently
   * discard every later caller's `excludeCommandId`, reintroducing the very
   * self-wait deadlock this mechanism exists to prevent (see the regression
   * this fixes).
   */
  private readonly excludedCommandIds = new Set<string>()

  constructor(
    project: ProjectRegistration,
    private readonly agentId: string,
    private readonly options: ProjectAgentOptions,
    localAgentChatMode?: AgentChatMode,
    defaultProjectDir?: string,
    private readonly onAuthRejected?: (transport: TransportKind) => void,
  ) {
    this.client = new ApiClient(project.apiUrl, project.token)
    this.prefix = `[${project.projectCode}]`
    this.tenantCode = ''
    this.apiUrl = project.apiUrl
    this.token = project.token
    this.projectCode = project.projectCode
    this.projectDir = initProjectDir(project, defaultProjectDir)

    this.configSyncDeps = {
      client: this.client,
      prefix: this.prefix,
      projectDir: this.projectDir,
      apiUrl: this.apiUrl,
      token: this.token,
      projectCode: this.projectCode,
      localAgentChatMode,
      onDockerRebuild: isInDocker()
        ? (commandId?: string) => { void this.performDockerRebuild(commandId) }
        : undefined,
    }

    this.transportDeps = {
      client: this.client,
      agentId: this.agentId,
      prefix: this.prefix,
      apiUrl: this.apiUrl,
      token: this.token,
      projectDir: this.projectDir,
      tenantCode: this.tenantCode,
      projectCode: this.projectCode,
      pollInterval: this.options.pollInterval,
      heartbeatInterval: this.options.heartbeatInterval,
      onAuthRejected: this.onAuthRejected,
      onEvicted: () => this.handleEviction(),
    }

    // When running inside Docker, initialize dockerCustomizationHash from the
    // docker-built-hash file so we don't trigger a rebuild for already-built customizations.
    // AI_SUPPORT_AGENT_CONFIG_DIR is mounted to the per-project config dir directly,
    // so docker-built-hash lives at the root of getConfigDir().
    if (isInDocker()) {
      const builtHashPath = path.join(getConfigDir(), DOCKER_MARKER_BUILT_HASH)
      // File may not exist yet — first startup, leave dockerCustomizationHash as undefined.
      const builtHash = readMarkerFile(builtHashPath)
      if (builtHash) {
        this.configSyncState.dockerCustomizationHash = builtHash
      }
    }
  }

  start(): void {
    if (this.isRegistering) {
      logger.debug(`${this.prefix} Register loop already running, skip start()`)
      return
    }
    this.isRegistering = true
    this.registerLoopCancelled = false
    this.registerAttempt = 0
    this.registerLoopPromise = this.runRegisterLoop().finally(() => {
      this.isRegistering = false
    })
    void this.registerLoopPromise
  }

  stop(): void {
    this.cancelRegisterLoop()
    this.stopWork()
  }

  /**
   * Cancel the register/admission loop: mark it cancelled, abort any pending
   * retry sleep, and wake a parked standby wait so the loop unwinds now
   * instead of up to REPLICA_STANDBY_RETRY_DELAY_MS later.
   *
   * Split out of `stop()` so `shutdown()` can cancel the register loop and
   * alert timers (see `clearAlertTimers`) up front, before draining, without
   * also stopping the transport — the transport must keep running through the
   * drain (heartbeats + any in-flight command's websocket dependency).
   */
  private cancelRegisterLoop(): void {
    this.stopGeneration += 1
    this.registerLoopCancelled = true
    this.registerAbortController?.abort()
    this.wakeStandbyWait()
  }

  private clearAlertTimers(): void {
    if (this.alertPollingTimer) {
      clearInterval(this.alertPollingTimer)
      this.alertPollingTimer = null
    }
    if (this.alertStaleRecoveryTimer) {
      clearInterval(this.alertStaleRecoveryTimer)
      this.alertStaleRecoveryTimer = null
    }
  }

  /**
   * Stop everything this replica does on behalf of its slot: transport
   * (AppSync subscription, WebSockets, heartbeat) and the alert polling timers.
   *
   * Used by both `stop()` and `handleEviction()`. Eviction previously stopped
   * only the transport, leaving the alert timers running — a replica that had
   * handed its slot to another one kept polling and processing alerts, which
   * both duplicates work and contradicts "a standby replica does no work".
   */
  private stopWork(): void {
    this.clearAlertTimers()
    if (this.pendingResultFlushTimer) {
      // NOTE: stopWork() also runs on eviction, so a replica that drops to standby
      // stops retrying. That matches "a standby replica does no work" — the command
      // is expected to be re-assigned and re-run by whoever holds the slot. The
      // residual risk is a result stranded on disk until this replica is re-admitted
      // (or, if it never is, until PENDING_RESULT_STALE_THRESHOLD_MS discards it and
      // logs a warning).
      clearInterval(this.pendingResultFlushTimer)
      this.pendingResultFlushTimer = null
    }
    stopTransport(this.transportState)
  }

  /**
   * Gracefully shut down: drain in-flight commands, then release this
   * replica's slot, before finally stopping the transport. Used by
   * SIGTERM/SIGINT and by the restart paths (reboot/update/docker rebuild)
   * instead of the synchronous `stop()`, so a command that is still executing
   * is never abandoned mid-flight — abandoning it and releasing the slot early
   * would let the server re-assign the command to another replica while this
   * one is still running it, executing it twice.
   *
   * Order matters:
   * 1. Guard against double-invocation (SIGTERM+SIGINT both firing).
   * 2. Mark the transport as draining so no *new* command is accepted.
   * 3. Cancel the register/admission loop and alert timers, but deliberately
   *    do NOT stop the transport yet: heartbeats must keep running through the
   *    drain (a) to keep the slot's lastHeartbeat fresh so the server does not
   *    consider it dead mid-drain, and (b) because an in-flight command may
   *    depend on the transport's websocket (e.g. e2e/browser-driven commands
   *    via the VS Code tunnel) that would otherwise be yanked out from under it.
   * 4. (handled by `handleEviction` checking `shuttingDown`) — heartbeats keep
   *    running, so the server could still reply `evicted: true` for unrelated
   *    reasons during the drain; that must not re-enter the standby loop while
   *    this process is already on its way out.
   * 5. Poll-wait for in-flight commands to drain.
   * 6. Release the slot — but only if the drain actually completed (not timed
   *    out: the process is going to die either way if it timed out, and
   *    releasing while a command might still be running would be wrong) and
   *    only if this replica ever held a slot in the first place.
   * 7. Stop the transport (same as the transport-stopping half of `stop()`).
   *
   * `opts.excludeCommandId`: the id of the command that is *itself* triggering
   * this shutdown (reboot/update). `processCommand` only removes a command's id
   * from `transportState.inFlightCommands` in a `finally` block that runs after
   * its handler (e.g. `performReboot`/`performUpdate`, which calls `shutdown()`)
   * has returned — so the triggering command's own id is still present in
   * `inFlightCommands` for the entire duration of this call. Without excluding
   * it, the drain below would wait for it to disappear, which can only happen
   * after `shutdown()` itself resolves: a deadlock that blocks for the full
   * drain timeout on every single reboot/update. SIGTERM/SIGINT-triggered
   * shutdowns pass no `excludeCommandId` — there is no in-flight command
   * driving those, so this is a no-op for that path.
   *
   * `excludeCommandId` is added to the shared `excludedCommandIds` set
   * *before* the memoization check below, not threaded through as a
   * parameter captured only by whichever caller happens to arrive first — see
   * `excludedCommandIds`'s doc comment for why: any caller that joins an
   * already-in-flight shutdown must still get its own exclusion honored.
   *
   * Concurrent-caller semantics: two independent call sites in
   * `runSingleProject()` (`src/agent-runner.ts`) can both call `shutdown()`
   * around the same time — the SIGTERM/SIGINT handler and the auto-updater's
   * `stopAllAgents` callback. A second caller here JOINS the first caller's
   * in-flight `doShutdown()` (awaits the same promise) rather than getting an
   * instant no-op; otherwise the second caller would proceed (e.g. the
   * auto-updater calling `reExecProcess()`) while the first caller's drain of
   * a genuinely in-flight command is still running, abandoning it mid-flight.
   * The second caller's `drainTimeoutMs` is ignored once a shutdown is already
   * in flight — the first caller's timeout wins, since restarting the drain
   * with a different timeout mid-flight doesn't make sense. `excludeCommandId`
   * is the one exception: it is always honored, from whichever caller
   * supplies it, via the shared set.
   */
  async shutdown(opts?: { drainTimeoutMs?: number; excludeCommandId?: string }): Promise<void> {
    if (opts?.excludeCommandId) {
      this.excludedCommandIds.add(opts.excludeCommandId)
    }
    if (this.shutdownPromise) return this.shutdownPromise
    this.shuttingDown = true
    this.shutdownPromise = this.doShutdown(opts?.drainTimeoutMs)
    return this.shutdownPromise
  }

  private async doShutdown(drainTimeoutMs?: number): Promise<void> {
    this.transportState.draining = true
    // Cancel any config-sync debounce timer that was already armed by a
    // CONFIG_UPDATE notification received just before draining started. The
    // `state.draining` guard in agent-transport.ts's CONFIG_UPDATE handler
    // only prevents *new* notifications from (re)arming this timer — it does
    // nothing for a timer that is already ticking down when draining flips
    // true. Left uncancelled, that timer would still fire mid-drain and can
    // trigger performConfigSync() -> (on a Docker customization change)
    // onDockerRebuild() -> performDockerRebuild(), which joins this same
    // shutdownPromise and then schedules its own delayed
    // process.exit(DOCKER_RESTART_EXIT_CODE) — racing the plain SIGTERM
    // handler's un-delayed process.exit(0) once the drain resolves. Clearing
    // here (not only in stopTransport() at the very end of shutdown) closes
    // that gap for the entire drain window, not just after it.
    if (this.transportState.configSyncDebounceTimer) {
      clearTimeout(this.transportState.configSyncDebounceTimer)
      this.transportState.configSyncDebounceTimer = null
    }

    this.cancelRegisterLoop()
    this.clearAlertTimers()

    const drainResult = await this.waitForDrain(drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS)

    if (!drainResult.drained) {
      logger.warn(
        t('runner.drainTimedOut', {
          prefix: this.prefix,
          commandIds: drainResult.remaining.join(', '),
        }),
      )
    } else if (this.slotHeld) {
      const result = await this.client.releaseSelf()
      if (result.released) {
        logger.info(t('runner.slotReleased', { prefix: this.prefix }))
      } else {
        logger.warn(
          t('runner.slotReleaseFailed', {
            prefix: this.prefix,
            reason: result.reason ?? 'unknown',
          }),
        )
      }
    } else {
      logger.debug(`${this.prefix} Skipping releaseSelf(): this replica never held a slot`)
    }

    stopTransport(this.transportState)
  }

  /**
   * Poll-wait for `transportState.inFlightCommands` to drain, using the same
   * interruptible/unref'd-timer poll style as the standby wait
   * (`waitInterruptible`) rather than a plain `sleep()`, so the wait never
   * holds the event loop open past process exit.
   *
   * Ids present in `this.excludedCommandIds` do not count toward "still in
   * flight": each is the id of a command (reboot/update/docker-rebuild) that
   * is itself driving a (possibly shared) shutdown, and it cannot be removed
   * from `inFlightCommands` until that command's own `shutdown()` call
   * returns — see `shutdown()`'s and `excludedCommandIds`'s doc comments for
   * why. The set is read live on every poll iteration (not snapshotted at the
   * start of the drain), so an exclusion added moments after this loop
   * started — e.g. by a caller joining an already-in-flight shutdown — is
   * picked up on the next iteration (within `SHUTDOWN_DRAIN_POLL_INTERVAL_MS`).
   */
  private async waitForDrain(
    timeoutMs: number,
  ): Promise<{ drained: boolean; remaining: string[] }> {
    const remainingCount = (): number => {
      let count = 0
      for (const id of this.transportState.inFlightCommands) {
        if (!this.excludedCommandIds.has(id)) count++
      }
      return count
    }
    const deadline = Date.now() + timeoutMs
    while (remainingCount() > 0 && Date.now() < deadline) {
      logger.debug(
        t('runner.drainWaiting', {
          prefix: this.prefix,
          count: remainingCount(),
        }),
      )
      await this.waitInterruptible(SHUTDOWN_DRAIN_POLL_INTERVAL_MS)
    }
    const remaining = Array.from(this.transportState.inFlightCommands).filter(
      (id) => !this.excludedCommandIds.has(id),
    )
    return { drained: remaining.length === 0, remaining }
  }

  /**
   * Restart the register loop after a `stop()` issued by this class itself
   * (token update / eviction recovery).
   *
   * `start()` is a no-op while `isRegistering` is true, so a bare
   * `setImmediate(() => this.start())` silently drops the restart whenever the
   * loop is parked on a long await — most notably the standby wait, which can
   * hold for the full retry delay. Losing the restart leaves the agent idle
   * forever. Waiting for the previous loop's promise guarantees the restart
   * lands after `isRegistering` has flipped back to false.
   *
   * The generation check prevents this deferred restart from resurrecting the
   * agent when a genuine external `stop()` (shutdown) arrives in the meantime.
   */
  private restartRegisterLoop(delayMs = 0): void {
    const generation = this.stopGeneration
    const previous = this.registerLoopPromise
    void Promise.resolve(previous)
      .catch(() => undefined)
      .then(async () => {
        if (delayMs > 0) {
          // 中断可能・unref 付きの待機。素の setTimeout だと shutdown 後も
          // タイマーがイベントループに残り、プロセスの終了を遅らせる。
          await this.waitInterruptible(delayMs)
        }
        if (this.stopGeneration !== generation) {
          logger.debug(
            `${this.prefix} Register loop restart superseded by a later stop()`,
          )
          return
        }
        this.start()
      })
  }

  isBusy(): boolean {
    // 実行中コマンドの有無から導出する。単一の boolean で持つと、複数コマンドを
    // 並行実行しているときに先に終わった1件が false に戻してしまい、自動更新が
    // 「暇だ」と判断して実行中の別コマンドごとプロセスを再起動する。
    return this.transportState.inFlightCommands.size > 0
  }

  getClient(): ApiClient {
    return this.client
  }

  updateToken(newToken: string): void {
    // shutdown()'s drain step deliberately keeps the transport alive while
    // waiting for in-flight commands (heartbeats + whatever transport an
    // in-flight command depends on). The old synchronous `stop()` this method
    // calls below would tear that transport down out from under the drain and
    // could re-arm `slotHeld` via a fresh register loop while the original
    // shutdown() call is still mid-drain — directly contradicting the point of
    // this feature. Same guard pattern as `handleEviction()`.
    if (this.shuttingDown) {
      logger.debug(
        `${this.prefix} Ignoring updateToken(): shutdown already in progress`,
      )
      return
    }
    this.token = newToken
    this.client.updateToken(newToken)
    this.configSyncDeps = { ...this.configSyncDeps, token: newToken }
    this.transportDeps = { ...this.transportDeps, token: newToken }
    logger.info(t('runner.tokenUpdated', { prefix: this.prefix }))

    // Token change may alter tenantCode/projectCode (embedded in token format).
    // Re-register to ensure the agent record matches the new token's identity.
    logger.info(`${this.prefix} Re-registering after token update...`)
    this.stop()
    // Restart once the in-flight loop has actually unwound. A bare
    // setImmediate would be dropped while the loop is parked on the standby
    // wait, leaving the agent stuck in standby forever after a token update.
    this.restartRegisterLoop()
  }

  /**
   * @param commandId The id of the `config_sync` command that triggered this
   *   call, when invoked via the command dispatch path (`onConfigSync`).
   *   Threaded through to `performDockerRebuild()` (via `onDockerRebuild`) so
   *   its `shutdown()` call can exclude this still-in-flight command from the
   *   drain wait — see `ConfigSyncDeps.onDockerRebuild`'s doc comment.
   *   `undefined` for background syncs (initial startup retry loop, debounced
   *   `config-update` notifications).
   */
  async performConfigSync(commandId?: string): Promise<void> {
    // ブラウザローカルポートを動的に更新（VSCode tunnel接続後に判明）
    this.configSyncDeps.browserLocalPort = this.transportState.vsCodeWs?.getBrowserLocalPort()
    // API通知の configHash はRDS同期前の古い値の可能性があるため、
    // config_update を受け取ったときは currentConfigHash をリセットして強制再同期する
    this.configSyncState.currentConfigHash = undefined
    await performConfigSync(this.configSyncDeps, this.configSyncState, commandId)
  }

  /**
   * @param commandId The id of the `setup` command that triggered this call.
   *   See `performConfigSync`'s doc comment — same threading, since `setup`
   *   performs a config sync internally and can trigger the same
   *   `onDockerRebuild` path.
   */
  async performSetup(commandId?: string): Promise<void> {
    await performSetup(this.configSyncDeps, this.configSyncState, commandId)
  }

  async performSyncRepository(repositoryCode: string, branch?: string): Promise<RepoSyncResult> {
    return performSyncRepository(this.configSyncDeps, this.configSyncState, { repositoryCode, branch })
  }

  /**
   * @param commandId The id of the 'reboot' command that triggered this call
   *   (when invoked via the command dispatch path). Passed through to
   *   `shutdown()` as `excludeCommandId` so the drain does not wait on this
   *   very command's own entry in `inFlightCommands` — see `shutdown`'s doc
   *   comment. Direct callers (e.g. tests) may omit it; `shutdown()` then
   *   drains normally, which is a no-op when nothing is in flight.
   */
  async performReboot(commandId?: string): Promise<void> {
    logger.info(`${this.prefix} Reboot requested, scheduling restart...`)
    await this.shutdown({ excludeCommandId: commandId })
    setTimeout(() => {
      // In Docker mode, exit with DOCKER_RESTART_EXIT_CODE so DockerSupervisor
      // restarts only this project's container.
      if (isInDocker()) {
        process.exit(DOCKER_RESTART_EXIT_CODE)
      } else if (process.send) {
        // Running as a child process (forked by ChildProcessManager) — exit cleanly.
        // The parent runner will restart the process automatically.
        process.exit(0)
      } else {
        reExecProcess()
      }
    }, DELAYED_RESTART_MS)
  }

  /**
   * @param commandId The id of the `config_sync` (or `setup`) command whose
   *   handler is still on the call stack when this fires — `performConfigSync`
   *   / `performSetup` invoke `onDockerRebuild` synchronously from inside
   *   `applyProjectConfig`, and `void`-call this method fire-and-forget, so
   *   this method's own `shutdown()` call below can run before that
   *   triggering command's handler has returned and `processCommand`
   *   (agent-transport.ts) has removed it from `inFlightCommands` in its
   *   `finally` block. Passed through to `shutdown()` as `excludeCommandId`
   *   for the same self-reference reason as `performReboot`/`performUpdate` —
   *   without it, the drain below would needlessly wait on the triggering
   *   command's own in-flight entry (up to the full drain timeout in the
   *   worst case) before finally giving up and proceeding anyway.
   *   `undefined` when there is no specific triggering command (e.g. the
   *   initial startup config sync in `registerAndStart()`, run before any
   *   command has ever been dispatched), which `shutdown()`/`waitForDrain()`
   *   already handle correctly.
   */
  async performDockerRebuild(commandId?: string): Promise<void> {
    logger.info(`${this.prefix} Docker rebuild requested, scheduling restart...`)
    await this.shutdown({ excludeCommandId: commandId })
    setTimeout(() => {
      // Inside Docker, AI_SUPPORT_AGENT_CONFIG_DIR is mounted to the per-project config dir directly.
      // All docker-related files live at the root of getConfigDir() (not in a projects sub-path).
      const configDir = getConfigDir()
      const markerPath = path.join(configDir, DOCKER_MARKER_REBUILD_NEEDED)
      try {
        fs.mkdirSync(configDir, { recursive: true })

        // Generate and write project-specific Dockerfile from dockerCustomization.
        // Place it at configDir/Dockerfile so DockerSupervisor can find it via getProjectDockerfilePath()
        // on the host (which maps to the same mounted directory).
        const dockerCustomization = this.configSyncState.projectConfig?.agent?.dockerCustomization
        const aptPackages = dockerCustomization?.aptPackages ?? []
        const npmPackages = dockerCustomization?.npmPackages ?? []
        const commands = dockerCustomization?.commands ?? []
        const timezone = dockerCustomization?.timezone
        const dockerfileContent = generateProjectDockerfile(AGENT_VERSION, aptPackages, npmPackages, commands, timezone)
        const dockerfilePath = path.join(configDir, 'Dockerfile')
        atomicWriteFile(dockerfilePath, dockerfileContent)
        logger.info(`${this.prefix} Project Dockerfile written: ${dockerfilePath}`)

        // Save the dockerCustomization hash so DockerSupervisor can copy it to docker-built-hash after build
        atomicWriteFile(
          path.join(configDir, DOCKER_MARKER_CUSTOMIZATION_HASH),
          this.configSyncState.dockerCustomizationHash ?? '',
        )

        atomicWriteFile(markerPath, '')
      } catch (err: unknown) {
        logger.warn(`${this.prefix} Failed to write ${DOCKER_MARKER_REBUILD_NEEDED} marker: ${getErrorMessage(err)}`)
      }
      process.exit(DOCKER_RESTART_EXIT_CODE)
    }, DELAYED_RESTART_MS)
  }

  /**
   * @param commandId The id of the 'update' command that triggered this call
   *   (when invoked via the command dispatch path). See `performReboot`'s doc
   *   comment — same self-reference reason for threading it into `shutdown()`.
   */
  async performUpdate(commandId?: string): Promise<void> {
    // 管理画面からの「バージョンアップ」も、自己更新が成立しない実行環境では実行しない。
    // Kubernetes や監督プロセスのいない PID 1 で走らせると、npm 更新のあとに
    // プロセスが終了してコンテナごと再作成され、イメージの版へ巻き戻る。
    // 成功したように見えて何も変わらない（むしろ稼働が途切れる）ため、
    // 代わりに何をすべきかを添えて明示的に失敗させる。
    const capability = resolveSelfUpdateCapability()
    if (!capability.capable && capability.reason) {
      throw new Error(describeSelfUpdateBlockReason(capability.reason))
    }

    const channel = detectChannelFromVersion(AGENT_VERSION)
    logger.info(`${this.prefix} Update requested, checking for latest version (channel: ${channel})...`)
    const versionInfo = await this.client.getVersionInfo(channel)
    const targetVersion = versionInfo.latestVersion
    if (!isNewerVersion(AGENT_VERSION, targetVersion)) {
      logger.info(`${this.prefix} Already up to date (${AGENT_VERSION})`)
      return
    }
    logger.info(`${this.prefix} Updating to version ${targetVersion}...`)
    const installMethod = detectInstallMethod()
    const cacheScope = `${this.tenantCode}-${this.projectCode}`
    const result = await performUpdate(targetVersion, installMethod, cacheScope)
    if (!result.success) {
      throw new Error(`Update failed: ${result.error ?? 'Unknown error'}`)
    }
    logger.success(`${this.prefix} Update to ${targetVersion} successful, restarting...`)
    await this.shutdown({ excludeCommandId: commandId })
    setTimeout(() => {
      // Inside a Docker container (spawned via `docker run`), process.send is
      // not available. Exit with DOCKER_UPDATE_EXIT_CODE so the host-side
      // DockerSupervisor detects the update and calls installUpdateAndRestart().
      if (isInDocker()) {
        try {
          atomicWriteFile(getUpdateVersionFilePath(), JSON.stringify({ version: targetVersion }))
        } catch (err: unknown) {
          logger.warn(`[update] Failed to write update-version.json: ${getErrorMessage(err)}`)
        }
        process.exit(DOCKER_UPDATE_EXIT_CODE)
        return
      }
      // When running as a child process (forked by ChildProcessManager),
      // notify the parent runner and exit cleanly.
      if (process.send) {
        process.send({ type: 'update_complete', tenantCode: this.tenantCode, projectCode: this.projectCode })
        process.exit(0)
      } else {
        reExecProcess(installMethod)
      }
    }, DELAYED_RESTART_MS)
  }

  private async registerAndStart(): Promise<void> {
    await refreshChatMode(this.configSyncDeps, this.configSyncState, true)

    // 'standby' when recovering from an eviction (see handleEviction), 'initial'
    // otherwise. Deliberately not reset before the call: if register throws, the
    // retry must keep the standby intent, or the retry would re-acquire the
    // right to evict and restart the ping-pong this flag exists to prevent.
    let result = await this.performRegistration(this.nextAdmissionMode)

    // Multi-replica deployments (Kubernetes / ECS): the plan's replica limit
    // may already be satisfied by other replicas. Rather than crash-looping
    // (which Kubernetes would surface as CrashLoopBackOff and which would
    // never resolve on its own), stay alive in standby and take over the
    // moment a slot frees up — a replica dying is exactly when a standby
    // should step in.
    if (result.admission && !result.admission.accepted) {
      this.logAdmissionRejectionReason(result.admission)
      result = await this.waitForAdmission(result)
      if (this.registerLoopCancelled) return
    }

    // Admission is now known to be accepted (either the initial register()
    // call above was accepted outright, or waitForAdmission() only returns
    // without cancellation once a standby retry is accepted) — the server has
    // already recorded this instance as holding the slot. Record that fact
    // immediately, before any further I/O (submitPendingResults(), the
    // config-sync retry loop below), rather than deferring to startServices().
    // Those steps involve real awaits, during which a concurrent shutdown()
    // may race in and cause an early return (see the registerLoopCancelled
    // check right before startServices() below) before startServices() ever
    // runs. If slotHeld were only set inside startServices(), that early
    // return would leave slotHeld false even though the slot genuinely is
    // held server-side — doShutdown() would then skip releaseSelf() and the
    // slot would only be freed via the slow ~90s heartbeat-timeout reclaim,
    // defeating the fast-release purpose of this feature. releaseSelf() is a
    // direct HTTP call to the server, independent of local transport state,
    // so it is correct to attempt it even if startServices() never ran.
    this.slotHeld = true

    // Submit any pending results from previous sessions.
    // Only the first registration of this process can safely take every file:
    // see hasRecoveredPendingResults.
    await submitPendingResults(
      this.hasRecoveredPendingResults
        ? { minAgeMs: PENDING_RESULT_MIN_RETRY_AGE_MS }
        : {},
    )
    this.hasRecoveredPendingResults = true

    // ...and keep retrying while this agent runs. The agent is long-lived and does
    // not restart when the API is deployed, so a one-shot submit at start-up loses
    // every result orphaned by a rollover.
    if (this.pendingResultFlushTimer) {
      clearInterval(this.pendingResultFlushTimer)
    }
    this.pendingResultFlushTimer = startPendingResultFlush()

    // Perform initial config sync with retries
    for (let attempt = 1; attempt <= INITIAL_CONFIG_SYNC_MAX_RETRIES; attempt++) {
      await this.performConfigSync()
      if (this.configSyncState.currentConfigHash) break
      if (attempt < INITIAL_CONFIG_SYNC_MAX_RETRIES) {
        logger.warn(`${this.prefix} Initial config sync attempt ${attempt} failed, retrying...`)
        await sleep(INITIAL_CONFIG_SYNC_RETRY_DELAY_MS * attempt)
      }
    }
    if (!this.configSyncState.currentConfigHash) {
      logger.warn(`${this.prefix} Initial config sync failed after all retries`)
    }

    // Re-check cancellation right before startServices(), mirroring the check
    // used in the rejected/standby branch above. submitPendingResults() and the
    // config-sync retry loop above involve real I/O with real await points; a
    // concurrent shutdown() (SIGTERM) may have already run cancelRegisterLoop()
    // while we were away — and, since `slotHeld` was already set true above (as
    // soon as admission was confirmed accepted), doShutdown() correctly attempts
    // releaseSelf() for the slot even though startServices() never got to run.
    // Without this check we would go on to start a brand-new heartbeat/
    // subscription right as the process is exiting, racing a stray heartbeat
    // against the in-flight shutdown.
    if (this.registerLoopCancelled) {
      logger.debug(
        `${this.prefix} Register loop cancelled before startServices(); skipping (shutdown in progress)`,
      )
      return
    }

    await this.startServices(result)

    // Reset only after the transport is actually up. Resetting right after
    // admission would re-arm the right to evict while startup can still fail
    // (config sync, AppSync connect); the retry would then come back as
    // 'initial' and evict whichever replica took the slot — the ping-pong this
    // flag exists to prevent.
    this.nextAdmissionMode = 'initial'
  }

  /**
   * Emit a one-time diagnostic warning for admission rejection reasons that
   * need operator attention beyond the generic "waiting for a slot" log
   * (`runner.replicaStandby`, emitted unconditionally by waitForAdmission for
   * every rejection). Called once, before entering the standby loop — not on
   * every standby retry — so it does not repeat on each re-request.
   *
   * `limit_reached` needs no extra explanation (the standby log already says
   * exactly what it is: the plan's replica limit). `instance_id_conflict` is
   * the case that needs a distinct, actionable log: it means another *live*
   * process is already registered under this same instanceId, which the
   * generic standby-wait log would otherwise make indistinguishable from an
   * ordinary "the plan is full" wait — see the 2026-08-15 incident where
   * identical Pod names across two Kubernetes clusters made the server treat
   * two separate processes as one replica reconnecting.
   */
  private logAdmissionRejectionReason(admission: AdmissionResult): void {
    if (admission.reason === 'instance_id_conflict') {
      logger.warn(
        `${this.prefix} ${t('runner.instanceIdConflict', {
          instanceId: this.client.getInstanceId(),
        })}`,
      )
    }
  }

  /**
   * Wait in standby until a replica slot frees up, then return the accepted
   * register response.
   *
   * Re-requests admission with `admissionMode: 'standby'`, which the server
   * admits only into a **free** slot. It deliberately never evicts on a
   * standby's behalf: if it did, an evicted replica would immediately evict
   * whoever took its place and the replicas would swap forever.
   *
   * No transport is started while waiting, so a standby replica holds no
   * WebSocket, receives no commands, and consumes no slot.
   */
  private async waitForAdmission(
    initial: RegisterResponse,
  ): Promise<RegisterResponse> {
    const admission = initial.admission
    logger.warn(
      `${this.prefix} ${t('runner.replicaStandby', {
        instanceId: this.client.getInstanceId(),
        live: String(admission?.liveReplicas ?? 0),
        max: String(admission?.maxReplicas ?? 0),
      })}`,
    )

    let result = initial
    while (!this.registerLoopCancelled) {
      await this.waitBeforeStandbyRetry()
      if (this.registerLoopCancelled) return result
      try {
        result = await this.performRegistration('standby')
      } catch (error) {
        // Transient failures must not end standby — keep waiting and retry.
        logger.debug(
          `${this.prefix} Standby admission request failed: ${getErrorMessage(error)}`,
        )
        continue
      }
      if (!result.admission || result.admission.accepted) {
        logger.success(
          `${this.prefix} ${t('runner.replicaAdmitted', {
            instanceId: this.client.getInstanceId(),
          })}`,
        )
        return result
      }
    }
    return result
  }

  /**
   * Wait before the next standby admission attempt, interruptibly.
   *
   * A plain `sleep()` would keep the register loop parked for the whole delay,
   * so `stop()` (shutdown, token update) could not unwind it promptly and the
   * follow-up restart would be dropped. `stop()` calls `wakeStandbyWait()` to
   * cut this short.
   */
  private waitBeforeStandbyRetry(): Promise<void> {
    if (this.registerLoopCancelled) {
      return Promise.resolve()
    }
    return this.waitInterruptible(REPLICA_STANDBY_RETRY_DELAY_MS)
  }

  /**
   * `stop()` で打ち切れる待機。タイマーは `unref()` してイベントループを
   * 押さえないようにする（素の `setTimeout` はシャットダウン後もプロセスの
   * 終了を最大で待機時間ぶん遅らせる）。
   */
  private waitInterruptible(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.standbyWakeup = null
        resolve()
      }, delayMs)
      timer.unref?.()
      this.standbyWakeup = () => {
        clearTimeout(timer)
        this.standbyWakeup = null
        resolve()
      }
    })
  }

  /** Cut a parked standby wait short (no-op when not waiting). */
  private wakeStandbyWait(): void {
    this.standbyWakeup?.()
  }

  /**
   * Called when a heartbeat reports this replica was evicted (a newer replica
   * took its slot). Stops all work and re-enters admission as a **standby**.
   *
   * Re-registering as `'initial'` here would break the ping-pong invariant:
   * the server lets `'initial'` evict the oldest live replica, so this replica
   * would immediately evict the one that just took its slot, that one would
   * come back the same way, and the two would swap forever. `'standby'` only
   * ever enters a free slot.
   */
  private handleEviction(): void {
    // The slot is gone either way (the server would not have sent this
    // notification otherwise), so record that regardless of shutdown state —
    // shutdown()'s drain logic reads slotHeld to decide whether to call
    // releaseSelf(), and skipping this update while shutting down would make
    // it try to release a slot that was already evicted/reassigned
    // server-side, producing a misleading runner.slotReleaseFailed warning
    // for what is actually an expected, already-handled eviction.
    this.slotHeld = false

    // Once shutdown() has started, heartbeats keep running through the drain
    // (see shutdown()'s step 3), so the server could still reply
    // `evicted: true` for unrelated reasons (e.g. another admin action) while
    // this process is already on its way out. Do nothing further in that case
    // — the normal reaction (re-entering standby) must not fire on a process
    // that is shutting down.
    if (this.shuttingDown) return
    if (this.registerLoopCancelled) return
    this.nextAdmissionMode = 'standby'
    this.stop()
    // Back off before re-entering admission. Being evicted means another
    // replica holds the slot, so an immediate retry cannot succeed anyway —
    // and without a delay a server that keeps reporting `evicted` would spin
    // the agent hot (register → immediate first heartbeat → evicted → …) with
    // no pause between iterations.
    this.restartRegisterLoop(REPLICA_STANDBY_RETRY_DELAY_MS)
  }

  /**
   * Calls the register API, updates local state from the response, and
   * performs any Docker-specific post-registration tasks (writing the
   * registered-agent-id marker and reporting a docker-build-error if present).
   *
   * Throws on failure so the caller's retry loop can apply exponential backoff.
   *
   * @param admissionMode `initial` on process start (may evict the oldest
   *   replica when the plan limit is reached); `standby` while waiting for a
   *   free slot (never evicts).
   */
  private async performRegistration(
    admissionMode: AdmissionMode = 'initial',
  ): Promise<RegisterResponse> {
    // 'ecs_launch' advertises that this resident agent can act as the
    // launcher for ECS execution agents (RunTask/StopTask via its local AWS
    // credentials); the API's automatic launcher selection matches on it.
    // Declared only when AWS credentials are resolvable (or force-enabled
    // via AI_SUPPORT_AGENT_ECS_LAUNCHER) — see ecs/launcher-capability.ts.
    // The detection is cached for the process lifetime, so register retries
    // do not re-probe the credential chain.
    const ecsLauncher = await detectEcsLauncherCapability()
    const result = await this.client.register({
      agentId: this.agentId,
      hostname: os.hostname(),
      os: os.platform(),
      arch: os.arch(),
      ipAddress: getLocalIpAddress(),
      capabilities: [
        'shell', 'file_read', 'file_write', 'process_manage', 'chat', 'terminal', 'vscode',
        // A resident agent can run server-setup recipe bodies (custom Ansible
        // tasks) directly over SSH; the api refuses to dispatch a body-carrying
        // recipe to any agent that does not advertise this capability.
        SERVER_SETUP_CUSTOM_TASKS_CAPABILITY,
        ...(ecsLauncher ? ['ecs_launch'] : []),
      ],
      availableChatModes: this.configSyncState.availableChatModes,
      activeChatMode: this.configSyncState.activeChatMode,
      admissionMode,
    })

    // Rejected admission carries no agent identity to apply — return it as-is
    // so the caller can enter standby without mutating local state.
    if (result.admission && !result.admission.accepted) {
      return result
    }

    this.tenantCode = result.tenantCode
    if (result.projectCode && result.projectCode !== this.projectCode) {
      logger.info(`${this.prefix} Server assigned projectCode: ${result.projectCode} (was: ${this.projectCode})`)
      this.projectCode = result.projectCode
      // Re-initialize projectDir with the server-assigned projectCode
      this.projectDir = initProjectDir({ tenantCode: this.tenantCode || 'unknown', projectCode: this.projectCode, token: this.token, apiUrl: this.apiUrl })
      this.configSyncDeps = { ...this.configSyncDeps, projectCode: this.projectCode, prefix: this.prefix, projectDir: this.projectDir }
    }
    this.prefix = `[${this.tenantCode}#${this.projectCode}]`
    this.configSyncDeps = { ...this.configSyncDeps, prefix: this.prefix }
    this.client.setTenantCode(this.tenantCode)
    this.client.setProjectCode(this.projectCode)
    this.transportDeps = { ...this.transportDeps, agentId: result.agentId, tenantCode: this.tenantCode, projectCode: this.projectCode, prefix: this.prefix, projectDir: this.projectDir }
    logger.success(t('runner.registered', { prefix: this.prefix, agentId: result.agentId }))
    logger.debug(`${this.prefix} Register response: transportMode=${result.transportMode ?? 'none'}, appsyncUrl=${result.appsyncUrl ? 'present' : 'absent'}, wsEnabled=${result.wsEnabled}`)
    logger.debug(`${this.prefix} Full register response keys: ${JSON.stringify(Object.keys(result))}`)

    // Report docker build error (if any) via heartbeat
    if (isInDocker()) {
      // Write the server-assigned agentId so the host DockerSupervisor can use it for log storage
      try {
        atomicWriteFile(path.join(getConfigDir(), DOCKER_MARKER_REGISTERED_AGENT_ID), result.agentId)
      } catch (err: unknown) {
        logger.warn(`${this.prefix} Failed to write ${DOCKER_MARKER_REGISTERED_AGENT_ID}: ${getErrorMessage(err)}`)
      }

      const buildErrorPath = path.join(getConfigDir(), 'docker-build-error')
      let dockerBuildError: string | undefined
      try {
        dockerBuildError = fs.readFileSync(buildErrorPath, 'utf-8').trim() || undefined
      } catch {
        // File does not exist — no build error
      }
      if (dockerBuildError !== undefined) {
        try {
          await this.client.heartbeat(
            result.agentId,
            { platform: os.platform(), arch: os.arch(), cpuUsage: 0, memoryUsage: 0, uptime: os.uptime() },
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            dockerBuildError,
          )
          // Delete the error file after successful report to avoid re-reporting on next startup
          try {
            fs.unlinkSync(buildErrorPath)
          } catch {
            // Ignore deletion failure — will be re-reported next time
          }
        } catch (err: unknown) {
          logger.warn(`${this.prefix} Failed to report docker build error: ${getErrorMessage(err)}`)
          // Keep the file so it can be reported on next startup
        }
      }
    }

    return result
  }

  /**
   * Starts all transport-layer services using the completed register response:
   * AppSync subscription, heartbeat, CloudWatch alert polling, and terminal/VS Code WebSocket.
   *
   * Throws if the AppSync URL is absent so the caller's retry loop retries the
   * whole registration flow (the URL may appear once a server-side rollout
   * completes). The agent authenticates to AppSync with its own agent token
   * (`this.token`) via the Lambda authorizer, so the master API key is no
   * longer required here.
   */
  private async startServices(result: RegisterResponse): Promise<void> {
    // slotHeld is set in registerAndStart() as soon as admission is known to
    // be accepted (see the comment there for why it must not wait until
    // here), not here — avoid a second, redundant assignment point.
    const commandContext = {
      configSyncState: this.configSyncState,
      configSyncDeps: this.configSyncDeps,
      transportState: this.transportState,
      onSetup: (commandId?: string) => this.performSetup(commandId),
      onConfigSync: (commandId?: string) => this.performConfigSync(commandId),
      onReboot: (commandId?: string) => this.performReboot(commandId),
      onUpdate: (commandId?: string) => this.performUpdate(commandId),
      onSyncRepository: (repositoryCode: string, branch?: string) => this.performSyncRepository(repositoryCode, branch),
    }

    if (!result.appsyncUrl) {
      // Propagate to runRegisterLoop so we retry — the URL may appear once
      // a server-side rollout completes.
      throw new Error('AppSync URL missing in register response')
    }
    if (!this.token) {
      // AppSync now authenticates via the agent token. An empty token would
      // subscribe with an empty Authorization header and get silently, and
      // permanently, rejected while register still reports success. Throw so
      // runRegisterLoop treats it as a registration failure and retries,
      // rather than fixing the agent in a no-op subscription.
      throw new Error('Agent token missing — cannot authenticate AppSync subscription')
    }
    logger.info(`${this.prefix} Starting subscription mode (realtime)`)
    // When running inside a Docker container, localhost refers to the container itself.
    // Convert localhost/127.0.0.1 to host.docker.internal so the container can reach the host.
    const resolvedAppsyncUrl = resolveUrlForDocker(result.appsyncUrl)
    await startSubscriptionMode(
      this.transportDeps,
      this.transportState,
      commandContext,
      AppSyncSubscriber,
      resolvedAppsyncUrl,
      // Authenticate to AppSync with the agent token (Lambda authorizer),
      // not the master API key.
      this.token,
    )

    startHeartbeat(this.transportDeps, this.transportState, this.configSyncState, this.configSyncDeps)

    // Start CloudWatch Alert polling if enabled in project config
    const projectConfig = this.configSyncState.projectConfig
    if (projectConfig?.cloudwatch?.enabled) {
      const alertProcessor = new AlertProcessor(
        this.client,
        this.transportDeps.tenantCode,
        this.transportDeps.projectCode,
      )
      // 起動時フォールバック: 蓄積された pending アラームを処理
      void alertProcessor.checkPendingAlerts()

      // 前のポーリングタイマーをクリア（再起動などで二重登録を防止）
      if (this.alertPollingTimer) {
        clearInterval(this.alertPollingTimer)
      }
      if (this.alertStaleRecoveryTimer) {
        clearInterval(this.alertStaleRecoveryTimer)
      }

      // 定期ポーリング（Web 画面で設定した間隔）pending のみ取得。
      // クラスフィールドで管理して stop() でクリア
      const pollingIntervalMs = projectConfig.cloudwatch.pollingIntervalMs
      this.alertPollingTimer = setInterval(
        () => void alertProcessor.checkPendingAlerts(),
        pollingIntervalMs,
      )
      logger.info(`${this.prefix} CloudWatch Alert polling started (interval: ${pollingIntervalMs}ms)`)

      // スタック救済タイマー（低頻度）。processing で止まったアラートを
      // 通常ポーリングとは分離して低頻度で救済する（無限ループ防止）。
      this.alertStaleRecoveryTimer = setInterval(
        () => void alertProcessor.recoverStaleProcessingAlerts(ALERT_STALE_PROCESSING_MINUTES),
        ALERT_STALE_RECOVERY_INTERVAL_MS,
      )
      logger.info(`${this.prefix} CloudWatch Alert stale-recovery started (interval: ${ALERT_STALE_RECOVERY_INTERVAL_MS}ms, threshold: ${ALERT_STALE_PROCESSING_MINUTES}min)`)
    }

    // Start terminal WebSocket connection (only if server has WS gateway enabled)
    if (result.wsEnabled) {
      const resolvedWsUrl = result.wsUrl ? resolveUrlForDocker(result.wsUrl) : result.wsUrl
      startTerminalWebSocket(this.transportDeps, this.transportState, resolvedWsUrl, this.configSyncState)
      startVsCodeTunnel(this.transportDeps, this.transportState, resolvedWsUrl, this.configSyncState)
    } else {
      logger.debug(`${this.prefix} Terminal/VS Code WebSocket skipped (wsEnabled=false)`)
    }
  }

  private async runRegisterLoop(): Promise<void> {
    while (!this.registerLoopCancelled) {
      try {
        await this.registerAndStart()
        // registerAndStart() returns normally both on success and when the loop
        // was cancelled mid-flight (token update / eviction calling stop()).
        // Without this check a cancellation would print the recovery message,
        // making the log claim a re-registration that never happened.
        if (this.registerLoopCancelled) return
        // Edge-triggered recovery log: only emit when we were previously failing.
        if (this.lastRegisterError !== null) {
          logger.info(
            t('runner.registerWorkingAgain', {
              prefix: this.prefix,
              attempts: this.registerAttempt,
            }),
          )
          this.lastRegisterError = null
        }
        this.registerAttempt = 0
        return
      } catch (error) {
        if (this.registerLoopCancelled) return

        const isAuth = isAuthenticationError(error)
        const message = getErrorMessage(error)
        const baseDelayMs = isAuth ? REGISTER_AUTH_ERROR_DELAY_MS : REGISTER_RETRY_BASE_DELAY_MS
        let delay = calculateBackoff({
          baseDelayMs,
          attempt: this.registerAttempt,
          jitter: true,
          maxDelayMs: REGISTER_RETRY_MAX_DELAY_MS,
        })
        if (isAuth) {
          // Floor at REGISTER_AUTH_ERROR_DELAY_MS so we never hammer the auth path.
          delay = Math.max(delay, REGISTER_AUTH_ERROR_DELAY_MS)
        }
        this.registerAttempt++

        // Edge-triggered failure log: only warn on a new failure or a change in
        // error mode (network -> auth, different error message). Subsequent
        // identical failures stay at debug level to avoid log flooding during
        // long outages.
        const isFirstFailure = this.lastRegisterError === null
        const isModeChange =
          this.lastRegisterError !== null &&
          (this.lastRegisterError.isAuth !== isAuth ||
            this.lastRegisterError.message !== message)
        const shouldWarn = isFirstFailure || isModeChange

        if (shouldWarn) {
          if (isAuth) {
            logger.warn(
              t('runner.authErrorStartedFailing', {
                prefix: this.prefix,
                delayMs: delay,
                detail: message,
              }),
            )
          } else {
            logger.warn(
              t('runner.registerStartedFailing', {
                prefix: this.prefix,
                delayMs: delay,
                message,
              }),
            )
          }
        } else {
          logger.debug(
            `${this.prefix} Registration still failing (attempt ${this.registerAttempt}, next retry in ${delay}ms): ${message}`,
          )
        }

        this.lastRegisterError = { isAuth, message }
        await this.cancellableSleep(delay)
      }
    }
  }

  private cancellableSleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const controller = new AbortController()
      this.registerAbortController = controller
      const timer = setTimeout(() => {
        this.registerAbortController = null
        resolve()
      }, ms)
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        this.registerAbortController = null
        resolve()
      })
    })
  }
}
