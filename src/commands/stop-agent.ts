/**
 * stop コマンド
 *
 * pidファイルから実行中エージェントのPIDを読み取り、SIGTERM を送信して正常停止させる。
 * エージェント側の shutdown ハンドラが docker stop を実行してコンテナも合わせて停止する。
 */
import {
  getPidFilePath,
  isEntryRunning,
  isProcessAlive,
  readPidFile,
  removePidFile,
} from '../pid-manager'
import { t } from '../i18n'
import { logger } from '../logger'
import { getErrorMessage, sleep } from '../utils'

const WAIT_INTERVAL_MS = 200
const WAIT_TIMEOUT_MS = 10_000

/** PIDが死ぬまで待機する（最大 WAIT_TIMEOUT_MS ms） */
async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(WAIT_INTERVAL_MS)
  }
  return false
}

export async function stopAgent(): Promise<void> {
  const entry = readPidFile()

  if (entry === null) {
    logger.warn(t('stop.notRunning', { path: getPidFilePath() }))
    return
  }

  const { pid } = entry

  // isAlreadyRunning() と同じ判定（ホスト名一致・起動世代マーカー・プロセス生存）を通す。
  // 生存確認だけで SIGTERM を送ると、別ホスト（別コンテナ）や前世代のプロセスが
  // 残した記録の pid 番号に、たまたま存在する無関係なプロセスを kill しうる。
  if (!isEntryRunning(entry)) {
    logger.warn(t('stop.staleProcess', { pid }))
    removePidFile()
    return
  }

  logger.info(t('stop.stopping', { pid }))

  try {
    process.kill(pid, 'SIGTERM')
  } catch (err: unknown) {
    logger.error(t('stop.signalFailed', { pid, message: getErrorMessage(err) }))
    return
  }

  const exited = await waitForExit(pid)

  if (exited) {
    // pidファイルは通常 shutdown ハンドラが削除するが、念のため残っていれば削除
    removePidFile()
    logger.success(t('stop.stopped'))
  } else {
    // WAIT_TIMEOUT_MS intentionally stays short (10s): SIGTERM can now
    // legitimately take up to SHUTDOWN_DRAIN_TIMEOUT_MS (~5 min) to result in
    // actual exit while ProjectAgent.shutdown() gracefully drains an
    // in-flight command, and this command should not block that long by
    // default. This is a messaging fix only — nothing is actually broken
    // when this fires; reword the message so it doesn't imply the process is
    // stuck when it may simply still be draining.
    logger.warn(t('stop.timeout', { pid, timeoutSeconds: WAIT_TIMEOUT_MS / 1000 }))
  }
}
