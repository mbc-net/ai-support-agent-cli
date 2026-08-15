/**
 * プロジェクト共有ファイルを 1 件、指定パスへ取り寄せる。
 *
 * サーバーセットアップのステージング（`server-setup/shared-file-staging.ts`）と
 * 共有ファイルのエージェント内配置（`shared-file-mounts.ts`）の両方から使う。
 * 取得経路（署名付き URL）を一箇所にまとめ、片方だけ扱いが変わることを防ぐ。
 */
import { createWriteStream, mkdirSync } from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'

import axios from 'axios'

import type { ApiClient } from './api-client'

/** 応答ヘッダを受け取るまでの上限 */
const RESPONSE_TIMEOUT_MS = 60_000
/** 受信が止まったと判断するまでの上限（大きなファイルの総時間は制限しない） */
const IDLE_TIMEOUT_MS = 120_000

/**
 * 共有ファイルを `destination` へストリーミング保存する。
 *
 * 数百MB を想定するため、メモリへ載せずに `pipeline` でディスクへ流す。
 * **署名付き URL はログに出さない**（短命とはいえ、URL 単体でファイルを取得できる）。
 * 0600 で書き出すのは、配布物に秘密鍵や認証情報を含み得るため。呼び出し側が
 * 別の権限を要求する場合は、配置後に chmod する。
 *
 * **タイムアウトを必ず付ける。** 無応答のまま待ち続けると、呼び出し側（配置処理）は
 * 成功も失敗も返せず、失敗をハートビートで可視化する仕組みが素通りしてしまう。
 */
export async function downloadProjectFileTo(
  client: ApiClient,
  sourcePath: string,
  destination: string,
): Promise<void> {
  const { downloadUrl } = await client.getProjectFileDownloadUrl(sourcePath)
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 })

  const controller = new AbortController()
  const response = await axios.get<Readable>(downloadUrl, {
    responseType: 'stream',
    timeout: RESPONSE_TIMEOUT_MS,
    signal: controller.signal,
  })

  // 受信が始まったあとに止まる場合は `timeout` では検出できないため、
  // データが流れている間だけ待つ無通信タイマーで打ち切る。
  let idleTimer: NodeJS.Timeout | undefined
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
  }
  armIdleTimer()
  response.data.on('data', armIdleTimer)

  try {
    await pipeline(response.data, createWriteStream(destination, { mode: 0o600 }))
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    response.data.off('data', armIdleTimer)
  }
}
