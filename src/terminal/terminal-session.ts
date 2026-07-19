import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile, spawnSync } from 'child_process'

import { SSH_NO_HOST_CHECK_FLAGS } from '../constants'
import { filterEnvVarsOverride } from '../env-vars-filter'
import { logger } from '../logger'
import { buildSafeEnv } from '../security'
import { ensureClaudeJsonIntegrity } from '../utils/claude-config-validator'
import { ensureClaudeJsonOAuthAccount } from '../utils/claude-json-oauth-sync'
import { getErrorMessage, sweepStaleEntries } from '../utils'
import {
  SCROLLBACK_BUFFER_MAX_BYTES,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
} from './constants'
import {
  buildSandboxInitScript,
  buildBashRcContent,
  buildZshRcContent,
  isZshShell,
} from './sandbox-init-script'

/**
 * Minimal subset of node-pty's IPty interface used by TerminalSession.
 * Defined locally so that tsc does not require node-pty's type declarations
 * at compile time (node-pty is an optionalDependency whose native build may
 * be absent in CI or non-desktop environments).
 */
interface IPty {
  readonly pid: number
  readonly cols: number
  readonly rows: number
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (e: { exitCode: number; signal?: number }) => void) => void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name?: string
      cols?: number
      rows?: number
      cwd?: string
      env?: Record<string, string>
    },
  ): IPty
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pty: PtyModule | null = null
let ptyLoadError: string | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty') as PtyModule
} catch (e: unknown) /* istanbul ignore next -- only when native build fails */ {
  ptyLoadError = getErrorMessage(e)
  logger.debug(`[terminal] node-pty is not available: ${ptyLoadError}`)
}

/**
 * node-pty が利用可能か確認する
 */
export function isNodePtyAvailable(): boolean {
  return pty !== null
}

/**
 * tmux バイナリが実行可能かを確認する。
 *
 * `spawnSync('tmux', ['--version'])` ではなく `fs.accessSync` でバイナリパスを
 * 直接チェックする。Docker コンテナ内の Node.js プロセスは shell init を経由せず
 * 起動するため、process.env.PATH がインタラクティブシェルの PATH と異なり
 * spawnSync がバイナリを見つけられないことがある。
 * 標準インストールパスを確認した後、PATH ベースの lookup をフォールバックとする。
 */
function isTmuxAvailable(): boolean {
  // Debian/Ubuntu (apt-get install tmux) → /usr/bin/tmux
  // Homebrew (macOS) / compiled → /usr/local/bin/tmux
  const candidates = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/bin/tmux']
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return true
    } catch {
      // not at this path
    }
  }
  // PATH ベースのフォールバック（非標準インストール先向け）
  try {
    const result = spawnSync('tmux', ['--version'], { encoding: 'utf-8' })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Resume-validation metadata recorded at PTY creation time.
 *
 * The API includes `meta` in the `open` message; the session stores it and a
 * later resume `open` must present an EXACTLY matching meta to reattach to
 * this PTY (see TerminalSessionManager.resumeSession). This prevents an
 * API-restart resume from handing an existing PTY to a different tenant /
 * project / user.
 */
export interface TerminalSessionMeta {
  tenantCode: string
  projectCode: string
  userId: string
}

export interface TerminalSessionOptions {
  cols?: number
  rows?: number
  cwd?: string
  /**
   * Web 設定（CLAUDE_CODE# / ENV# 由来）から流れてくる env オーバーレイ。
   * PTY 環境に最後にマージされ、ユーザーが対話シェルから `claude` を起動した
   * 際にも Web の `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` /
   * `ANTHROPIC_MODEL` 等が効くようにする。
   * 含まれないキーは PTY が継承する process.env をそのまま残す。
   */
  envVarsOverride?: Record<string, string>
  /**
   * Resume 検証用メタ（tenantCode / projectCode / userId）。
   * open メッセージの meta をそのまま記録し、resume open の meta と完全一致
   * した場合のみ既存 PTY への再接続を許可する。
   */
  meta?: TerminalSessionMeta
  /**
   * アタッチ先の tmux セッション名。
   * 指定された場合はこの名前で tmux new-session -A を実行し、既存セッションがあれば
   * アタッチする。省略時は ais-{sessionId} を自動生成する。
   */
  tmuxSessionName?: string
}

export interface TerminalSessionInfo {
  sessionId: string
  pid: number
  cols: number
  rows: number
  cwd: string
  createdAt: number
  lastActivity: number
}

type DataCallback = (data: string) => void
type ExitCallback = (code: number | null) => void

/**
 * SSH キーの環境変数名
 *
 * API サーバーが base64 エンコードされた PEM 秘密鍵をこの変数名で送ってくる。
 * TerminalSession はこれを検出してファイルに書き出し、GIT_SSH_COMMAND を設定する。
 * この変数自体は PTY には渡さない（ファイルパスが GIT_SSH_COMMAND 経由で参照される）。
 */
export const GIT_SSH_KEY_ENV_NAME = 'GIT_SSH_KEY_CONTENT_BASE64'

export class TerminalSession {
  readonly sessionId: string
  readonly pid: number
  cols: number
  rows: number
  readonly cwd: string
  readonly createdAt: number
  private lastActivity: number
  private readonly ptyProcess: IPty
  private sandboxTmpDir: string | null = null
  private sshKeyFile: string | null = null
  private tmuxSessionName: string | null = null
  private dataCallback: DataCallback | null = null
  private exitCallback: ExitCallback | null = null
  /**
   * Internal exit callback owned by the session manager for its own cleanup
   * (clear grace timer + remove from map). It is kept separate from the public
   * `exitCallback` so that a later `onExit()` registration by the websocket
   * handler (which sends the 'exit' frame) does NOT overwrite the manager's
   * cleanup. Both fire on PTY exit.
   */
  private internalExitCallback: ExitCallback | null = null
  private exited = false
  /** Resume-validation meta recorded at creation (null when the open had no meta). */
  private readonly meta: TerminalSessionMeta | null
  /**
   * Scrollback ring buffer: PTY output chunks appended alongside the live
   * stdout relay, capped at SCROLLBACK_BUFFER_MAX_BYTES by dropping the OLDEST
   * bytes. Replayed to the client on a successful resume.
   */
  private readonly scrollbackChunks: Buffer[] = []
  private scrollbackBytes = 0

  /**
   * 過去の terminal-sandbox-* ディレクトリを一括削除する。
   *
   * 通常は session 終了時 (kill / onExit) に `cleanupTmpDir` で削除されるが、
   * agent process が SIGKILL / クラッシュした場合は孤立した sandbox dir が
   * `/tmp` に残る。長期稼働で累積すると ENOSPC を引き起こすため、起動時に
   * クリーンアップする。
   *
   * デフォルトは 24 時間以上前の sandbox のみ削除。`maxAgeMs=0` で全削除。
   *
   * @param maxAgeMs 削除対象とする経過時間 (ms)。0 で全削除
   * @returns 削除した件数
   */
  static cleanupStaleSandboxes(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    return sweepStaleEntries(os.tmpdir(), (name) => name.startsWith('terminal-sandbox-'), {
      maxAgeMs,
      recursive: true,
    })
  }

  constructor(sessionId: string, options: TerminalSessionOptions = {}) {
    /* istanbul ignore if -- only when native build fails */
    if (!pty) {
      throw new Error(
        `Terminal functionality is not available: node-pty failed to load. ${ptyLoadError ?? 'Unknown error'}`,
      )
    }

    this.sessionId = sessionId
    this.meta = options.meta ?? null
    this.cols = options.cols ?? TERMINAL_DEFAULT_COLS
    this.rows = options.rows ?? TERMINAL_DEFAULT_ROWS
    this.cwd = options.cwd ?? process.cwd()
    this.createdAt = Date.now()
    this.lastActivity = this.createdAt

    const shell = process.env.SHELL ?? '/bin/bash'
    const safeEnv = buildSafeEnv()
    const env: Record<string, string> = {
      ...safeEnv,
      TERM: 'xterm-256color',
    }
    // node-pty requires PATH to locate spawn-helper
    if (!env.PATH) {
      env.PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    }

    // サンドボックス初期化スクリプトを一時ファイルに書き出す
    const sandboxScript = buildSandboxInitScript(path.resolve(this.cwd))
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-sandbox-'))
    this.sandboxTmpDir = tmpDir

    const shellArgs: string[] = []
    if (isZshShell(shell)) {
      fs.writeFileSync(path.join(tmpDir, '.zshrc'), buildZshRcContent(sandboxScript))
      env.ZDOTDIR = tmpDir
      shellArgs.push('--login')
    } else {
      fs.writeFileSync(path.join(tmpDir, '.bashrc'), buildBashRcContent(sandboxScript))
      shellArgs.push('--rcfile', path.join(tmpDir, '.bashrc'))
    }

    // Web 設定（CLAUDE_CODE# / ENV#）由来の env オーバーレイを最後にマージ。
    // 含まれないキーは safeEnv (= process.env から PATH/TERM 等を引き継いだもの) が残る。
    //
    // 二層防御: api 側 AgentEnvVarsService が既に denylist フィルタを通している
    // はずだが、agent 側でも filterEnvVarsOverride を通して PATH/ZDOTDIR 等の
    // sandbox 関連キーが上書きされないことを保証する。これにより api 側の
    // regression や別経路からの流入があっても sandbox を維持できる。
    //
    // GIT_SSH_KEY_CONTENT_BASE64 は特別扱い: フィルタに通す前に取り出し、
    // ファイルに書き出して GIT_SSH_COMMAND として設定する。
    const rawOverride = options.envVarsOverride ?? {}
    const sshKeyBase64 = rawOverride[GIT_SSH_KEY_ENV_NAME]
    const overrideWithoutSshKey: Record<string, string> = { ...rawOverride }
    delete overrideWithoutSshKey[GIT_SSH_KEY_ENV_NAME]

    if (sshKeyBase64) {
      try {
        const pemContent = Buffer.from(sshKeyBase64, 'base64').toString('utf-8')
        const sshKeyPath = path.join(os.tmpdir(), `ssh-key-${sessionId}`)
        fs.writeFileSync(sshKeyPath, pemContent, { mode: 0o600 })
        this.sshKeyFile = sshKeyPath
        env.GIT_SSH_COMMAND = `ssh -i ${sshKeyPath} ${SSH_NO_HOST_CHECK_FLAGS}`
        logger.debug(`[terminal:${sessionId}] SSH key configured for git operations`)
      } catch {
        logger.warn(`[terminal:${sessionId}] Failed to set up SSH key for git; continuing without SSH key`)
      }
    }

    const filteredOverride = filterEnvVarsOverride(overrideWithoutSshKey, {
      prefix: `[terminal:${sessionId}]`,
    })
    for (const [key, value] of Object.entries(filteredOverride)) {
      env[key] = value
    }

    // Claude Code 対話モードは ~/.claude.json の oauthAccount キーが
    // 存在しないと CLAUDE_CODE_OAUTH_TOKEN env を持っていても /login プロンプトを出す。
    // PTY 起動前に、(1) JSON 破損があれば backup から復元、(2) oauthAccount placeholder
    // を確保する。両者は ~/.claude.json を触るため順序が重要 (integrity 先 → oauth-sync 後)。
    ensureClaudeJsonIntegrity()
    ensureClaudeJsonOAuthAccount(filteredOverride, {
      prefix: `[terminal:${sessionId}]`,
    })

    // tmux 自動アタッチ: tmux が利用可能ならターミナルを tmux セッション内で起動する。
    // tmux が新規ウィンドウ/ペインを開く際に使うシェルを $SHELL で指定するため、
    // sandbox 制限付きのラッパースクリプトを生成して $SHELL に設定する。
    const shellQuoted = shell.replace(/'/g, "'\\''")
    const argsQuoted = shellArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const wrapperPath = path.join(tmpDir, 'shell-wrapper')
    fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec '${shellQuoted}' ${argsQuoted} "$@"\n`, {
      mode: 0o700,
    })

    let spawnFile: string
    let spawnArgs: string[]
    if (isTmuxAvailable()) {
      // Normally the API always supplies tmuxSessionName in the form
      // `ais-{userHash}-{sessionId}` (owner-partitioned). The `ais-${sessionId}`
      // default here is only a safety net for standalone agent startup without
      // the API; it has no owner partition and is intentionally excluded from
      // the owner-filtered tmux list.
      this.tmuxSessionName = options.tmuxSessionName ?? `ais-${sessionId}`
      spawnFile = 'tmux'
      spawnArgs = [
        'new-session',
        '-A',
        '-s', this.tmuxSessionName,
        '-x', String(this.cols),
        '-y', String(this.rows),
      ]
      env.SHELL = wrapperPath
      logger.debug(`[terminal:${sessionId}] tmux session: ${this.tmuxSessionName}`)
    } else {
      logger.warn(`[terminal:${sessionId}] tmux not found; starting shell directly`)
      spawnFile = shell
      spawnArgs = shellArgs
    }

    this.ptyProcess = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env,
    })

    this.pid = this.ptyProcess.pid

    this.ptyProcess.onData((data: string) => {
      this.touchActivity()
      // Append to the scrollback ring buffer alongside the live relay so a
      // later resume can replay output produced while the WS was down.
      this.appendScrollback(data)
      if (this.dataCallback) {
        this.dataCallback(data)
      }
    })

    this.ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      this.exited = true
      this.cleanupTmpDir()
      this.killTmuxSession()
      // Manager cleanup runs first and unconditionally, then the public
      // (websocket) listener. The internal slot cannot be overwritten by a
      // later onExit() call, so map/grace-timer cleanup always happens.
      if (this.internalExitCallback) {
        this.internalExitCallback(exitCode)
      }
      if (this.exitCallback) {
        this.exitCallback(exitCode)
      }
    })
  }

  /**
   * Register the (single) live data relay callback. Registration REPLACES any
   * previous callback — it does not add a listener — so re-registering on a
   * resume cannot double-send stdout.
   */
  onData(callback: DataCallback): void {
    this.dataCallback = callback
  }

  /** Resume-validation meta recorded at creation, or null if none was given. */
  getMeta(): TerminalSessionMeta | null {
    return this.meta
  }

  /**
   * Snapshot of the scrollback ring buffer (oldest → newest), at most
   * SCROLLBACK_BUFFER_MAX_BYTES bytes. Returns an empty Buffer when no output
   * has been produced yet.
   */
  getScrollbackBuffer(): Buffer {
    return Buffer.concat(this.scrollbackChunks)
  }

  /**
   * Append PTY output to the ring buffer, evicting the OLDEST bytes once the
   * total exceeds SCROLLBACK_BUFFER_MAX_BYTES. Eviction may slice a chunk in
   * the middle; the cut is then advanced to the next UTF-8 character boundary
   * (a buffer starting mid-sequence would replay as U+FFFD mojibake at the
   * top of the restored scrollback), so the kept total may fall a few bytes
   * under the cap.
   */
  private appendScrollback(data: string): void {
    let chunk = Buffer.from(data, 'utf-8')
    // A single chunk larger than the cap: keep only its newest tail.
    if (chunk.byteLength > SCROLLBACK_BUFFER_MAX_BYTES) {
      chunk = chunk.subarray(
        alignToUtf8Boundary(chunk, chunk.byteLength - SCROLLBACK_BUFFER_MAX_BYTES),
      )
    }
    this.scrollbackChunks.push(chunk)
    this.scrollbackBytes += chunk.byteLength
    while (this.scrollbackBytes > SCROLLBACK_BUFFER_MAX_BYTES) {
      const oldest = this.scrollbackChunks[0]
      const excess = this.scrollbackBytes - SCROLLBACK_BUFFER_MAX_BYTES
      const cut =
        excess >= oldest.byteLength ? oldest.byteLength : alignToUtf8Boundary(oldest, excess)
      if (cut >= oldest.byteLength) {
        // Drop the whole oldest chunk.
        this.scrollbackChunks.shift()
        this.scrollbackBytes -= oldest.byteLength
      } else {
        // Trim only the leading bytes of the oldest chunk.
        this.scrollbackChunks[0] = oldest.subarray(cut)
        this.scrollbackBytes -= cut
      }
    }
  }

  onExit(callback: ExitCallback): void {
    this.exitCallback = callback
  }

  /**
   * Register the manager-owned exit cleanup. Separate from the public onExit so
   * it survives the websocket handler re-registering onExit on open/resume.
   */
  setOnExitInternal(callback: () => void): void {
    this.internalExitCallback = callback
  }

  write(data: string): void {
    if (this.exited) return
    this.touchActivity()
    this.ptyProcess.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return
    this.cols = cols
    this.rows = rows
    this.ptyProcess.resize(cols, rows)
    // tmux new-session -A で既存セッションにアタッチした場合、起動時の -x/-y は
    // 無視され古いウィンドウサイズが残る（周囲がドットで埋まる崩れの原因）。
    // resize ごとに resize-window を明示的に呼んでウィンドウサイズを追従させる。
    // （resize-window は window-size を manual にする副作用があるが、毎回呼ぶため問題ない）
    if (this.tmuxSessionName) {
      const name = this.tmuxSessionName
      execFile(
        'tmux',
        ['resize-window', '-t', name, '-x', String(cols), '-y', String(rows)],
        (err) => {
          if (!err) return
          // 「セッションが既に消えている」系は正常な競合なので無視する。
          const message = getErrorMessage(err)
          if (/can't find session|no such session|session not found/i.test(message)) {
            return
          }
          // それ以外（tmux バイナリ不在 ENOENT・権限エラー等の恒常的失敗）は
          // デバッグ困難になるため記録する。resize は高頻度なので debug レベルに留める。
          logger.debug(`[terminal:${this.sessionId}] tmux resize-window failed: ${message}`)
        },
      )
    }
    this.touchActivity()
  }

  kill(): void {
    if (this.exited) return
    this.ptyProcess.kill()
    this.cleanupTmpDir()
    this.killTmuxSession()
  }

  private cleanupTmpDir(): void {
    if (this.sandboxTmpDir) {
      try {
        fs.rmSync(this.sandboxTmpDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
      this.sandboxTmpDir = null
    }
    if (this.sshKeyFile) {
      try {
        fs.rmSync(this.sshKeyFile, { force: true })
      } catch {
        // ignore cleanup errors
      }
      this.sshKeyFile = null
    }
  }

  /**
   * tmux セッションを kill する（fire-and-forget, エラーは無視）。
   * tmuxSessionName を null にして二重実行を防ぐ。
   */
  private killTmuxSession(): void {
    if (!this.tmuxSessionName) return
    const name = this.tmuxSessionName
    this.tmuxSessionName = null
    execFile('tmux', ['kill-session', '-t', name], () => {
      // セッションが既に消えていてもエラーを無視する
    })
  }

  isAlive(): boolean {
    return !this.exited
  }

  getInfo(): TerminalSessionInfo {
    return {
      sessionId: this.sessionId,
      pid: this.pid,
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
    }
  }

  // Diagnostics only — lastActivity is exposed via getInfo() for monitoring.
  // It does NOT drive any eviction or timer; do not add idle-kill logic here.
  private touchActivity(): void {
    this.lastActivity = Date.now()
  }
}

/**
 * Advance `pos` past UTF-8 continuation bytes (0b10xxxxxx) so a leading cut
 * lands on a character boundary. Cutting mid-sequence would leave orphaned
 * continuation bytes that decode to U+FFFD on replay.
 */
function alignToUtf8Boundary(buf: Buffer, pos: number): number {
  while (pos < buf.byteLength && (buf[pos] & 0xc0) === 0x80) {
    pos++
  }
  return pos
}
