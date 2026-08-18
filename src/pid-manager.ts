/**
 * PID ファイル管理
 *
 * ai-support-agent start 時に親プロセスの PID を記録し、
 * ai-support-agent stop コマンドで SIGTERM を送信して正常停止させる。
 *
 * ファイル形式: "{hostname}:{pid}:{generation}"
 *
 * stale 判定は「ホスト名」と「起動世代マーカー (generation)」の2軸で行う。
 * generation は記録したプロセスの開始時刻（epoch 秒）であり、
 * `Date.now() / 1000 - process.uptime()` で算出する。
 * - Node 標準 API のみで求まるため macOS でも動作する（/proc/<pid>/stat は使わない）。
 * - wall clock 基準なので、ホスト再起動をまたいでも値が衝突しない。
 * - 算出タイミングによる丸め誤差があるため、比較には ±GENERATION_TOLERANCE_SECONDS の
 *   許容差を持たせる。
 *
 * ホスト名だけに依存してはいけない理由（実機で再現した障害）:
 * - Docker のデフォルトホスト名はコンテナIDの短縮形（例: 26890c1018aa）で
 *   再作成ごとに変わるが、Kubernetes では os.hostname() が Pod 名を返し、
 *   StatefulSet では序数付き（例: agent-0）でコンテナ再作成をまたいで不変になる。
 * - さらにコンテナの ENTRYPOINT は `exec "$@"` するため、エージェントは常に PID 1 で動く。
 * - この2つが重なると、永続ボリューム上に残った PID ファイル（例: "agent-0:1:..."）が
 *   新しいプロセス自身を指すため isProcessAlive(1) が真になり、自分自身を
 *   「既に稼働中の別プロセス」と誤認して永久に起動できなくなる。
 * generation を併記することで、pid が自分自身を指す記録であっても、それが
 * 前世代のプロセスが残したものか自分が書いたものかを区別できる。
 *
 * 記録された pid が自プロセス以外を指す場合の判定はプロセス生存確認のみで行う
 * （実ホスト上での二重起動検知を弱めないため）。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { getConfigDir } from './config-manager'
import { ensureDir, isErrnoException } from './utils'

const PID_FILE_NAME = 'agent.pid'

/** generation 比較の許容差（秒）。算出タイミングによる丸め誤差を吸収する */
const GENERATION_TOLERANCE_SECONDS = 2

export function getPidFilePath(): string {
  return path.join(getConfigDir(), PID_FILE_NAME)
}

/** 現在のプロセスの起動世代マーカー（プロセス開始時刻の epoch 秒）を返す */
function currentGeneration(): number {
  return Math.round(Date.now() / 1000 - process.uptime())
}

/**
 * 既存の pidファイルを確認し、プロセスが生存中なら true を返す。
 * 複数起動防止チェックに使用する。
 */
export function isAlreadyRunning(): boolean {
  const entry = readPidFile()
  if (entry === null) return false
  return isEntryRunning(entry)
}

/**
 * pidファイルのエントリが「今このホストで稼働中のエージェント」を指しているか判定する。
 *
 * 1. ホスト名が現在のホスト名と異なる → stale（別コンテナ・別ホストの記録）
 * 2. pid が自プロセスを指す（Kubernetes の PID 1 再利用、実ホストでの pid 再利用）
 *    → 起動世代マーカーが一致するときのみ稼働中とみなす
 * 3. pid が自プロセス以外を指す → プロセス生存確認の結果に従う
 */
export function isEntryRunning(entry: PidEntry): boolean {
  if (entry.hostname !== os.hostname()) return false
  if (entry.pid === process.pid) {
    // 旧形式（generation なし）: 自分の pid を指す記録を自分は書いていないため前世代のもの
    if (entry.generation === undefined) return false
    return Math.abs(entry.generation - currentGeneration()) <= GENERATION_TOLERANCE_SECONDS
  }
  return isProcessAlive(entry.pid)
}

/** 現在のプロセス PID を pidファイルに書き込む */
export function writePidFile(): void {
  const pidPath = getPidFilePath()
  ensureDir(path.dirname(pidPath))
  fs.writeFileSync(pidPath, `${os.hostname()}:${process.pid}:${currentGeneration()}`, 'utf-8')
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
  /** 記録したプロセスの開始時刻（epoch 秒）。旧形式のpidファイルでは undefined */
  generation?: number
}

/**
 * pidファイルからエントリを読み込む。
 * ファイルが存在しない・無効な場合は null を返す。
 *
 * 後方互換のため、旧形式 "{hostname}:{pid}" とレガシー形式（数値のみ）も受け付ける。
 * どちらも generation を持たないため、自プロセスの pid を指す場合は stale と判定される。
 */
export function readPidFile(): PidEntry | null {
  const pidPath = getPidFilePath()
  try {
    const content = fs.readFileSync(pidPath, 'utf-8').trim()
    const parts = content.split(':')
    if (parts.length === 1) {
      // レガシー形式（数値のみ）: ホスト名なしなのでstaleとみなす
      const pid = parseInt(parts[0], 10)
      if (!Number.isFinite(pid) || pid <= 0) return null
      return { hostname: '', pid }
    }
    const hostname = parts[0]
    const pid = parseInt(parts[1], 10)
    if (!Number.isFinite(pid) || pid <= 0) return null
    if (parts.length < 3) {
      // 旧形式 "{hostname}:{pid}"
      return { hostname, pid }
    }
    const generation = parseInt(parts[2], 10)
    if (!Number.isFinite(generation)) return { hostname, pid }
    return { hostname, pid, generation }
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
  } catch (err: unknown) {
    // EPERM: プロセスは存在するが送信権限がない → 生存中とみなす
    if (isErrnoException(err, 'EPERM')) return true
    return false
  }
}
