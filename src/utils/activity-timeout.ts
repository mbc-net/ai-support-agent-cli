/**
 * アクティビティベースのタイムアウト管理
 * データ受信のたびに reset() を呼び出してタイマーをリセットする
 */
export interface ActivityTimeout {
  /** タイマーをリセット（アクティビティ発生時に呼び出す） */
  reset: () => void
  /** タイマーをクリア（プロセス終了時に呼び出す） */
  clear: () => void
}

/**
 * アクティビティタイムアウトを作成する
 *
 * @param timeoutMs - 非アクティブ時間の上限（ミリ秒）
 * @param onTimeout - タイムアウト発生時のコールバック
 * @returns reset / clear を持つオブジェクト
 */
export function createActivityTimeout(
  timeoutMs: number,
  onTimeout: () => void,
): ActivityTimeout {
  let timer: NodeJS.Timeout | undefined

  const reset = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onTimeout, timeoutMs)
  }

  const clear = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  // 初期タイマーを開始
  reset()

  return { reset, clear }
}
