import { Worker } from 'worker_threads'

import { API_TOOL_WORKER_TIMEOUT_MS } from '../constants'
import { logger } from '../logger'
import { getErrorMessage } from '../utils'

import type { ToolExecutionOutcome } from './api-tool-executor'

/**
 * Grep/Glob（`api-tool-executor.ts`）は ReDoS・シンボリックリンク循環など、原理的に
 * 静的解析だけでは検出しきれないハングを起こしうる処理を含む
 * （`isDangerousRegexPattern` は「明らかに危険なパターンを早期に安価に弾く」高速パスに
 * すぎず、唯一の防御ではない）。これらを Worker スレッド内で実行し、タイムアウト時に
 * `worker.terminate()` で強制終了することで、メインスレッド（＝同一 agent プロセス内の
 * 他の全チャット・他テナント）を巻き込まずに済むようにする。
 *
 * `Promise.race` によるタイムアウトは、同一スレッドで同期的にブロックする
 * `regex.test()` や無限再帰には無力（イベントループ自体が止まるため）なので採用しない。
 * `worker.terminate()` は同期実行中のコードも強制的に停止できる。
 */

// Grep/Glob の実処理は同居する api-tool-executor.ts（executeReadOnlyTool）にある。
// dev/test（ts-node/ts-jest）ではソースがそのまま `.ts` として存在し、本番ビルドでは
// tsc の出力である `.js` になる。require.resolve() で実行時の実ファイルパスを解決して
// おき、Worker 側では CWD に依存しない絶対パスで require する
// （グローバルインストールされる CLI は任意の CWD で起動されうるため）。
const TOOL_MODULE_PATH = require.resolve('./api-tool-executor')

interface WorkerRequest {
  id: number
  name: string
  input: Record<string, unknown>
  sandboxRoots: string[]
}

interface WorkerResponse {
  id: number
  ok: boolean
  result?: ToolExecutionOutcome
  error?: string
}

/**
 * Worker スレッドのブートストラップ本体（`eval: true` で実行される）。
 * dev/test では `ts-node`（transpileOnly、tsconfig.json の `ts-node` セクション設定を
 * 継承）を Worker スレッド内で登録してから `.ts` の実体モジュールを require する。
 * 本番（`.js`）ではそのまま require する（ts-node は本番の依存関係に含まれないため、
 * `.js` の場合はそもそも参照しない）。
 *
 * 複数リクエストを同一 Worker で使い回せるよう、`parentPort` に持続的な message
 * ハンドラを登録する（呼び出し元の api-tool-worker-runner.ts が Worker を使い回す）。
 */
const WORKER_BOOTSTRAP = `
const { workerData, parentPort } = require('worker_threads');
function loadToolModule(modulePath, tsNodePath) {
  if (modulePath.endsWith('.ts')) {
    const tsNode = require(tsNodePath || 'ts-node');
    tsNode.register({ transpileOnly: true });
  }
  return require(modulePath);
}
const mod = loadToolModule(workerData.modulePath, workerData.tsNodePath);
parentPort.on('message', async (req) => {
  try {
    const result = await mod.executeReadOnlyTool(req.name, req.input, req.sandboxRoots);
    parentPort.postMessage({ id: req.id, ok: true, result: result });
  } catch (err) {
    parentPort.postMessage({ id: req.id, ok: false, error: (err && err.message) ? err.message : String(err) });
  }
});
`

/** dev/test のみで使う。本番（.js）では呼ばれない（見つからなくても本番挙動に影響しない）。 */
function resolveTsNodePath(): string | undefined {
  try {
    return require.resolve('ts-node')
  } catch {
    return undefined
  }
}

let sharedWorker: Worker | null = null
let requestSeq = 0

function createWorker(): Worker {
  const worker = new Worker(WORKER_BOOTSTRAP, {
    eval: true,
    workerData: {
      modulePath: TOOL_MODULE_PATH,
      tsNodePath: TOOL_MODULE_PATH.endsWith('.ts') ? resolveTsNodePath() : undefined,
    },
  })
  // Worker が生きているだけで agent プロセスの正常終了を妨げないようにする
  // （他に何も無ければプロセスは終了できる。in-flight リクエストの応答性には影響しない）。
  worker.unref()
  worker.on('error', (err) => {
    logger.warn(`[api-tool-worker] worker thread error: ${getErrorMessage(err)}`)
  })
  return worker
}

function getWorker(): Worker {
  if (!sharedWorker) {
    sharedWorker = createWorker()
  }
  return sharedWorker
}

/**
 * タイムアウト／abort／クラッシュ発生時、状態が壊れている可能性のある Worker を
 * 破棄する。次回呼び出し時に新しい Worker が作られる。
 */
function discardWorker(worker: Worker): void {
  if (sharedWorker === worker) {
    sharedWorker = null
  }
  worker.removeAllListeners()
  void worker.terminate().catch(() => { /* already dead/dying — ignore */ })
}

/**
 * Grep/Glob を Worker スレッド内で実行する。
 *
 * - `API_TOOL_WORKER_TIMEOUT_MS` を超過した場合、または `abortSignal` が発火した場合、
 *   `worker.terminate()` で強制終了し `{isError: true}` を返す（例外は投げない）。
 * - Worker はプロセス内で使い回される（毎呼び出しごとに新規作成しない）。タイムアウト／
 *   abort／クラッシュ時のみ破棄し、次回呼び出しで新しい Worker を作り直す。
 */
export function runToolInWorker(
  name: string,
  input: Record<string, unknown>,
  sandboxRoots: string[],
  abortSignal?: AbortSignal,
): Promise<ToolExecutionOutcome> {
  return new Promise((resolve) => {
    const worker = getWorker()
    const id = ++requestSeq

    let settled = false
    const finish = (outcome: ToolExecutionOutcome): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    const onMessage = (msg: WorkerResponse): void => {
      if (msg.id !== id) return
      if (msg.ok && msg.result) {
        finish(msg.result)
      } else {
        finish({ output: `Error: ${msg.error ?? 'unknown worker error'}`, isError: true })
      }
    }
    const onError = (err: Error): void => {
      discardWorker(worker)
      finish({ output: `Error: tool worker crashed: ${getErrorMessage(err)}`, isError: true })
    }
    const onExit = (code: number): void => {
      discardWorker(worker)
      finish({ output: `Error: tool worker exited unexpectedly (code ${code})`, isError: true })
    }
    const onTimeout = (): void => {
      logger.warn(`[api-tool-worker] ${name} timed out after ${API_TOOL_WORKER_TIMEOUT_MS}ms; terminating worker`)
      discardWorker(worker)
      finish({
        output: `Error: ${name} tool execution timed out after ${API_TOOL_WORKER_TIMEOUT_MS}ms`,
        isError: true,
      })
    }
    const onAbort = (): void => {
      discardWorker(worker)
      finish({ output: `Error: ${name} tool execution was cancelled`, isError: true })
    }

    const timer = setTimeout(onTimeout, API_TOOL_WORKER_TIMEOUT_MS)

    function cleanup(): void {
      clearTimeout(timer)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
      abortSignal?.removeEventListener('abort', onAbort)
    }

    worker.on('message', onMessage)
    worker.on('error', onError)
    worker.on('exit', onExit)
    abortSignal?.addEventListener('abort', onAbort, { once: true })

    const request: WorkerRequest = { id, name, input, sandboxRoots }
    worker.postMessage(request)
  })
}

/**
 * テスト用: プロセス内で共有される Worker シングルトンを破棄する。
 * テストスイート終了時に呼び、Worker スレッド（実 OS スレッド）のリークを防ぐ。
 */
export function _terminateSharedWorker(): Promise<void> {
  if (!sharedWorker) return Promise.resolve()
  const worker = sharedWorker
  sharedWorker = null
  worker.removeAllListeners()
  return worker.terminate().then(() => undefined).catch(() => undefined)
}
