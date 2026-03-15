/**
 * 実行中のプロセス/チャットを commandId で管理する共通クラス
 */
export class ProcessManager {
  private readonly running = new Map<string, { cancel: () => void }>()

  /** プロセスを管理 Map に登録 */
  register(id: string, handle: { cancel: () => void }): void {
    this.running.set(id, handle)
  }

  /**
   * プロセスをキャンセルして Map から削除
   * @returns true: プロセスが見つかりキャンセルした, false: プロセスが見つからなかった
   */
  cancel(id: string): boolean {
    const handle = this.running.get(id)
    if (handle) {
      handle.cancel()
      this.running.delete(id)
      return true
    }
    return false
  }

  /** プロセスを Map から削除（キャンセルせずに完了時の削除用） */
  remove(id: string): void {
    this.running.delete(id)
  }

  /** テスト用: running Map の内容を取得 */
  _getRunning(): Map<string, { cancel: () => void }> {
    return this.running
  }
}

// Shared singleton instance
const processManager = new ProcessManager()

/** シングルトンの ProcessManager インスタンスを取得 */
export function getProcessManager(): ProcessManager {
  return processManager
}

/**
 * 実行中のプロセス/チャットをキャンセルする（統一インターフェース）
 *
 * chat-executor と api-chat-executor の両方が同じシングルトン ProcessManager を
 * 共有しているため、この関数1つで全てのプロセスをキャンセルできる。
 *
 * @returns true: プロセスが見つかりキャンセルした, false: プロセスが見つからなかった
 */
export function cancelProcess(commandId: string): boolean {
  return processManager.cancel(commandId)
}

/**
 * テスト用: シングルトン ProcessManager の running Map の内容を取得
 */
export function _getRunningProcesses(): Map<string, { cancel: () => void }> {
  return processManager._getRunning()
}
