import * as fs from 'fs'
import * as os from 'os'

import { logger } from './logger'
import type { SystemInfo } from './types'

/** /tmp の使用率がこの値を超えたら warning ログを出す閾値（%） */
const DISK_USAGE_WARN_THRESHOLD = 85
/** 同じ閾値の警告を最低この間隔で再ログする（ms） */
const DISK_USAGE_WARN_REPEAT_MS = 10 * 60 * 1000 // 10 分

let lastDiskUsageWarnAt = 0

/**
 * tmp 領域の使用率 (%) を返す。取得失敗時は undefined。
 *
 * Node.js には disk 使用率の標準 API が無いため `fs.statfsSync` (Node 18.15+)
 * を使う。利用不可な環境では undefined を返してフォールバック。
 */
export function getDiskUsagePercent(
  targetPath: string = os.tmpdir(),
): number | undefined {
  const statfs = (
    fs as unknown as {
      statfsSync?: (p: string) => { blocks: number; bfree: number; bavail: number }
    }
  ).statfsSync
  if (typeof statfs !== 'function') return undefined
  try {
    const stat = statfs(targetPath)
    if (!stat || stat.blocks <= 0) return undefined
    const used = stat.blocks - stat.bfree
    return (used / stat.blocks) * 100
  } catch {
    return undefined
  }
}

export function getSystemInfo(): SystemInfo {
  const cpus = os.cpus()
  const diskUsagePercent = getDiskUsagePercent()
  // ENOSPC の予兆を heartbeat より早く拾えるよう、超過時に agent ログに残す。
  // heartbeat 頻度が高いと毎秒ログが流れるため、最後の警告から 10 分以内は
  // 同じメッセージを抑制する。
  if (
    diskUsagePercent !== undefined &&
    diskUsagePercent >= DISK_USAGE_WARN_THRESHOLD
  ) {
    const now = Date.now()
    if (now - lastDiskUsageWarnAt >= DISK_USAGE_WARN_REPEAT_MS) {
      logger.warn(
        `Disk usage on ${os.tmpdir()}: ${diskUsagePercent.toFixed(1)}% (threshold: ${DISK_USAGE_WARN_THRESHOLD}%). ` +
          `Terminal/Browser sessions may fail with ENOSPC.`,
      )
      lastDiskUsageWarnAt = now
    }
  }
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpuUsage: cpus.length > 0 ? (os.loadavg()[0] / cpus.length) * 100 : 0,
    memoryUsage: (1 - os.freemem() / os.totalmem()) * 100,
    uptime: os.uptime(),
    diskUsagePercent,
  }
}

export function getLocalIpAddress(): string | undefined {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return undefined
}
