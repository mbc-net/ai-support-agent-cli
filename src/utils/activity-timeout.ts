/**
 * アクティビティベースのタイムアウト管理
 * データ受信のたびに reset() を呼び出してタイマーをリセットする
 */
export interface ActivityTimeout {
  /** タイマーをリセット（アクティビティ発生時に呼び出す） */
  reset: () => void
  /**
   * 通常タイムアウトを停止し、フォールバックタイムアウトに切り替える。
   * ツール実行中など stdout 出力が期待されない期間に呼び出す。
   * maxPauseMs が指定されていない場合はタイマーを完全停止する。
   */
  pause: () => void
  /** タイマーをクリア（プロセス終了時に呼び出す） */
  clear: () => void
}

/**
 * アクティビティタイムアウトを作成する
 *
 * @param timeoutMs - 非アクティブ時間の上限（ミリ秒）
 * @param onTimeout - タイムアウト発生時のコールバック
 * @param maxPauseMs - pause() 中のフォールバックタイムアウト（ミリ秒）。
 *                     指定しない場合、pause() はタイマーを完全停止する。
 * @returns reset / pause / clear を持つオブジェクト
 */
export function createActivityTimeout(
  timeoutMs: number,
  onTimeout: () => void,
  maxPauseMs?: number,
): ActivityTimeout {
  let timer: NodeJS.Timeout | undefined

  const reset = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onTimeout, timeoutMs)
  }

  const pause = (): void => {
    if (timer) clearTimeout(timer)
    if (maxPauseMs !== undefined) {
      timer = setTimeout(onTimeout, maxPauseMs)
    } else {
      timer = undefined
    }
  }

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  // 初期タイマーを開始
  reset()

  return { reset, pause, clear }
}
