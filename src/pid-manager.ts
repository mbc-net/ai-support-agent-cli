/**
 * PID ファイル管理
 *
 * ai-support-agent start 時に親プロセスの PID を記録し、
 * ai-support-agent stop コマンドで SIGTERM を送信して正常停止させる。
 */
import * as fs from 'fs'
import * as path from 'path'

import { getConfigDir } from './config-manager'

const PID_FILE_NAME = 'agent.pid'

export function getPidFilePath(): string {
  return path.join(getConfigDir(), PID_FILE_NAME)
}

/** 現在のプロセス PID を pidファイルに書き込む */
export function writePidFile(): void {
  const pidPath = getPidFilePath()
  const dir = path.dirname(pidPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(pidPath, String(process.pid), 'utf-8')
}

/** pidファイルを削除する（存在しない場合は無視） */
export function removePidFile(): void {
  const pidPath = getPidFilePath()
  try {
    fs.unlinkSync(pidPath)
  } catch {
    // ファイルが存在しない場合は無視
  }
}

/**
 * pidファイルからPIDを読み込む。
 * ファイルが存在しない・無効な場合は null を返す。
 */
export function readPidFile(): number | null {
  const pidPath = getPidFilePath()
  try {
    const content = fs.readFileSync(pidPath, 'utf-8').trim()
    const pid = parseInt(content, 10)
    if (!Number.isFinite(pid) || pid <= 0) return null
    return pid
  } catch {
    return null
  }
}

/**
 * 指定PIDのプロセスが生存しているか確認する。
 * process.kill(pid, 0) は実際にシグナルを送らず存在チェックのみ行う。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
