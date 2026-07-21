import type { ChildProcess } from 'child_process'

import { CHAT_SIGKILL_DELAY } from '../constants'
import { logger } from '../logger'

/**
 * SIGKILL への段階的エスカレーションをスケジュールする。
 * CHAT_SIGKILL_DELAY 経過後もプロセスが生存していれば SIGKILL を送る。
 */
export function scheduleForceKill(child: ChildProcess, cliLabel: string): NodeJS.Timeout {
  return setTimeout(() => {
    if (!child.killed) {
      logger.warn(`[chat] ${cliLabel} CLI still running after SIGTERM, sending SIGKILL (pid=${child.pid})`)
      child.kill('SIGKILL')
    }
  }, CHAT_SIGKILL_DELAY)
}

/** SIGTERM を送り、応答がなければ SIGKILL にエスカレーションする */
export function killWithEscalation(child: ChildProcess, cliLabel: string): NodeJS.Timeout {
  child.kill('SIGTERM')
  return scheduleForceKill(child, cliLabel)
}
