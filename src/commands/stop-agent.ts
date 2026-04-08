/**
 * stop コマンド
 *
 * pidファイルから実行中エージェントのPIDを読み取り、SIGTERM を送信して正常停止させる。
 * エージェント側の shutdown ハンドラが docker stop を実行してコンテナも合わせて停止する。
 */
import { getPidFilePath, isProcessAlive, readPidFile, removePidFile } from '../pid-manager'
import { t } from '../i18n'
import { logger } from '../logger'

const WAIT_INTERVAL_MS = 200
const WAIT_TIMEOUT_MS = 10_000

/** PIDが死ぬまで待機する（最大 WAIT_TIMEOUT_MS ms） */
async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise<void>((resolve) => setTimeout(resolve, WAIT_INTERVAL_MS))
  }
  return false
}

export async function stopAgent(): Promise<void> {
  const pid = readPidFile()

  if (pid === null) {
    logger.warn(t('stop.notRunning', { path: getPidFilePath() }))
    return
  }

  if (!isProcessAlive(pid)) {
    logger.warn(t('stop.staleProcess', { pid }))
    removePidFile()
    return
  }

  logger.info(t('stop.stopping', { pid }))

  try {
    process.kill(pid, 'SIGTERM')
  } catch (err) {
    logger.error(t('stop.signalFailed', { pid, message: err instanceof Error ? err.message : String(err) }))
    return
  }

  const exited = await waitForExit(pid)

  if (exited) {
    // pidファイルは通常 shutdown ハンドラが削除するが、念のため残っていれば削除
    removePidFile()
    logger.success(t('stop.stopped'))
  } else {
    logger.warn(t('stop.timeout', { pid }))
  }
}
