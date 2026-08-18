/**
 * Reports "this run is about to restart the agent that is executing it".
 *
 * WHY THIS EXISTS: the `ai_support_agent_k8s` bundled role may deploy the very
 * agent running the play. Every spec-changing kubectl call for that target is
 * deferred until all other projects are deployed (ansible/roles/
 * ai_support_agent_k8s/tasks/self.yml), but it still ends the run without a
 * result: Kubernetes replaces the Pod, so the process that would call
 * `submitResult` is gone. Server-side the execution stays `running` until the
 * watchdog reclaims it two hours later, and the UI can only show "実行中".
 *
 * The role therefore drops a marker file on the controller — this agent's own
 * filesystem — immediately before it touches its own StatefulSet, and then
 * *waits* for the ack file this module writes. That wait is what turns
 * "declared before restarted" into an ordering guarantee instead of a race
 * between a 1-second poll and `kubectl apply`.
 *
 * DECIDING ON A FILE, NOT ON WORDING: the signal is the marker's **existence**.
 * Nothing here parses ansible's or kubectl's output — the previous round of
 * review removed exactly such a check (`'unchanged' not in stdout`-style
 * matching) because it misfired on every run. The marker's content is read for
 * the log line only, and a content that cannot be read does not change the
 * decision.
 *
 * WHEN THE DECLARATION FAILS, IT HAS TO BE VISIBLE. The deployment still
 * proceeds — that part is deliberate — but the failure is no longer confined to
 * this process's stdout, which Kubernetes is about to throw away along with the
 * process. Three things now carry it:
 *   1. a `failed` entry in the execution's own task log, through the same
 *      progress channel the run's Ansible tasks use (where an operator looks);
 *   2. the ack file's **content** (`{"declared": false, ...}`), which the role
 *      reads back and prints — existence alone never proved anything, since
 *      this file is written locally and therefore almost always succeeds;
 *   3. a warning on the api side, logged the moment it answers 200 to a notice
 *      it could not apply.
 * The likeliest failure is not a thrown error at all: the api applies the flag
 * best-effort and answers 200 either way, so `acknowledged: false` in the reply
 * is a failure here, and a caller that only caught rejections would miss it.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'

import {
  SERVER_SETUP_MAX_PROGRESS_MESSAGE_LENGTH,
  SERVER_SETUP_SELF_RESTART_NOTICE_SEQ,
} from '../constants'
import { logger } from '../logger'
import type {
  SelfRestartDeclarationAck,
  ServerSetupProgressEvent,
} from '../types/server-setup'
import { getErrorMessage } from '../utils'

/** Cap on the marker text echoed into the log line (diagnostics only). */
const MAX_LOGGED_MARKER_LENGTH = 500

/**
 * Task name the failure notice carries into the execution's task log.
 *
 * Shaped like an Ansible task name (`role : what it does`) because it lands in
 * the same list as real ones — an operator scanning the run should not have to
 * work out where this line came from.
 */
export const SELF_RESTART_NOTICE_TASK_NAME =
  'ai_support_agent_k8s : Report this run as awaiting a self restart'

export interface SelfRestartDeclarerOptions {
  /** Controller-side path the role writes just before restarting this agent. */
  markerPath: string
  /** Controller-side path the role waits on before it proceeds. */
  ackPath: string
  /**
   * Sends the declaration to the API.
   *
   * Rejections are absorbed (see below), and so is an ack that says the api
   * could not apply it: a 200 with `acknowledged: false` is a *failure* here,
   * not a success, and is the likelier of the two — the api applies the flag on
   * a best-effort path that answers 200 even when its own write threw.
   */
  declare: () => Promise<SelfRestartDeclarationAck | void>
  /**
   * Appends to the execution's task log — the same channel the mid-run progress
   * uses. Used for exactly one thing: recording that the declaration did not
   * get through.
   *
   * This is what makes the failure *visible*. A `logger.error` goes to this
   * process's stdout, and this process is about to be replaced by Kubernetes;
   * nothing of it survives into the execution the operator is looking at.
   * Omitted on paths with no execution row to append to (local dev runs).
   */
  reportProgress?: (events: ServerSetupProgressEvent[]) => Promise<void>
}

export interface SelfRestartDeclarer {
  /**
   * Declares once if the role has raised the marker. Never rejects: it runs on
   * the progress poll loop, which must keep ticking regardless.
   */
  check(): Promise<void>
}

export function createSelfRestartDeclarer(
  options: SelfRestartDeclarerOptions,
): SelfRestartDeclarer {
  const { markerPath, ackPath, declare, reportProgress } = options
  // One-way latch, set *before* the first await: `check()` is called once per
  // poll, and a declaration slower than the poll interval would otherwise be
  // started again on the next tick (and could answer the role with an ack
  // while the first attempt is still in flight).
  let handled = false

  /**
   * Puts the failure where an operator actually looks: the execution's task
   * log. Best-effort in turn — if the API is what is broken, this fails for the
   * same reason the declaration did, and the deployment still has to proceed.
   */
  const reportFailure = async (notice: string): Promise<void> => {
    if (!reportProgress) return
    try {
      await reportProgress([
        {
          seq: SERVER_SETUP_SELF_RESTART_NOTICE_SEQ,
          phase: 'end',
          name: SELF_RESTART_NOTICE_TASK_NAME,
          status: 'failed',
          changed: false,
          // No redaction pass: this text is composed here from the agent's own
          // HTTP outcome, not from Ansible output, and the declaration request
          // carries no secret material. Truncated only because the api rejects
          // the whole request when the field is over its limit.
          message: notice.slice(0, SERVER_SETUP_MAX_PROGRESS_MESSAGE_LENGTH),
        },
      ])
    } catch (error) {
      logger.error(
        `[server-setup] failed to record the self-restart reporting failure in the execution log: ${getErrorMessage(error)}`,
      )
    }
  }

  return {
    async check(): Promise<void> {
      if (handled) return
      if (!existsSync(markerPath)) return
      handled = true

      let detail = ''
      try {
        detail = readFileSync(markerPath, 'utf8').trim().slice(0, MAX_LOGGED_MARKER_LENGTH)
      } catch (error) {
        // Existence is the signal; the content is diagnostics. Failing here
        // would drop a declaration we already know is due.
        detail = `<unreadable: ${getErrorMessage(error)}>`
      }
      logger.info(
        `[server-setup] this run is about to restart the agent executing it; reporting it before proceeding: ${detail}`,
      )

      // Why the declaration did not land, or undefined when it did. Both
      // rejections *and* a 200 the api could not apply end up here: the second
      // is the likelier one (the api absorbs its own DB errors and still
      // answers 200), and it is precisely the case a caller that only looked
      // for a thrown error would read as success.
      let failure: string | undefined
      try {
        const ack = await declare()
        if (ack && ack.acknowledged === false) {
          failure = `the server accepted the request but did not apply it (outcome=${
            ack.outcome ?? 'unknown'
          })`
        }
      } catch (error) {
        // Best-effort, on the same terms as progress reporting: the deployment
        // must not be held hostage by a reporting failure.
        failure = getErrorMessage(error)
      }

      if (failure !== undefined) {
        const notice =
          `Could not report that this run awaits a self restart: ${failure}. ` +
          `Deploying this agent anyway — the agent that is executing this run is about to be ` +
          `replaced, so no result will ever be submitted and this execution will stay "running" ` +
          `until it is stopped from the admin UI or reclaimed by the server-side watchdog.`
        // stdout first, so the reason exists even if the channel below is the
        // thing that is broken.
        logger.error(`[server-setup] ${notice}`)
        await reportFailure(notice)
      }

      try {
        // Written only after the declaration settled. The role's `wait_for`
        // returns the moment this path exists, so writing it any earlier would
        // let the Pod be replaced with the declaration still in flight — the
        // exact race this module exists to close. It is written even when the
        // declaration failed: leaving the role to burn its whole wait window
        // would delay the deployment without making the report any more likely.
        //
        // The *content* records the outcome. Existence alone was being read by
        // the role as "the declaration got through", which it never proved —
        // this file is written locally and therefore almost always succeeds.
        writeFileSync(
          ackPath,
          `${JSON.stringify({
            declared: failure === undefined,
            at: new Date().toISOString(),
            ...(failure === undefined ? {} : { error: failure }),
          })}\n`,
          { mode: 0o600 },
        )
      } catch (error) {
        // The role waits out its timeout and deploys anyway; say why.
        logger.error(
          `[server-setup] failed to acknowledge the self-restart marker at ${ackPath}: ${getErrorMessage(error)}`,
        )
      }
    },
  }
}
