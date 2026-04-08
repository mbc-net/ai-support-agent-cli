/**
 * PID ファイル管理
 *
 * ai-support-agent start 時に親プロセスの PID を記録し、
 * ai-support-agent stop コマンドで SIGTERM を送信して正常停止させる。
 *
 * ファイル形式: "{hostname}:{pid}"
 * ホスト名も一緒に記録することで、コンテナ再起動後にstaleなPIDファイルを無効化できる。
 * Dockerコンテナのデフォルトホスト名はコンテナIDの短縮形（例: 26890c1018aa）であり、
 * 再起動のたびに変わるため、前のコンテナが残したPIDファイルとは一致しない。
 * NOTE: docker run に --hostname を指定するとこの仕組みが壊れるため、指定してはいけない。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getConfigDir } from './config-manager'

const PID_FILE_NAME = 'agent.pid'

export function getPidFilePath(): string {
  return path.join(getConfigDir(), PID_FILE_NAME)
}

/**
 * 既存の pidファイルを確認し、プロセスが生存中なら true を返す。
 * 複数起動防止チェックに使用する。
 *
 * ファイルに記録されたホスト名が現在のホスト名と異なる場合（コンテナ再起動等）は
 * staleとみなして false を返す。
 */
export function isAlreadyRunning(): boolean {
  const entry = readPidFile()
  if (entry === null) return false
  if (entry.hostname !== os.hostname()) return false
  return isProcessAlive(entry.pid)
}

/** 現在のプロセス PID を pidファイルに書き込む */
export function writePidFile(): void {
  const pidPath = getPidFilePath()
  const dir = path.dirname(pidPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(pidPath, `${os.hostname()}:${process.pid}`, 'utf-8')
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

export interface PidEntry {
  hostname: string
  pid: number
}

/**
 * pidファイルからエントリを読み込む。
 * ファイルが存在しない・無効な場合は null を返す。
 */
export function readPidFile(): PidEntry | null {
  const pidPath = getPidFilePath()
  try {
    const content = fs.readFileSync(pidPath, 'utf-8').trim()
    const colonIdx = content.indexOf(':')
    if (colonIdx === -1) {
      // レガシー形式（数値のみ）: ホスト名なしなのでstaleとみなす
      const pid = parseInt(content, 10)
      if (!Number.isFinite(pid) || pid <= 0) return null
      return { hostname: '', pid }
    }
    const hostname = content.slice(0, colonIdx)
    const pid = parseInt(content.slice(colonIdx + 1), 10)
    if (!Number.isFinite(pid) || pid <= 0) return null
    return { hostname, pid }
  } catch {
    return null
  }
}

/**
 * 指定PIDのプロセスが生存しているか確認する。
 * process.kill(pid, 0) は実際にシグナルを送らず存在チェックのみ行う。
 * EPERM（権限なし）の場合はプロセスが存在しているため true を返す。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: プロセスは存在するが送信権限がない → 生存中とみなす
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true
    return false
  }
}
