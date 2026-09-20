import { GuacdSocket } from './guacd-handshake'
import { encodeGuacamoleInstruction } from './guacamole-protocol'
import { RdpSession, RdpSessionAbortedError } from './rdp-session'

/**
 * Owns the agent's live RDP sessions and turns API messages into guacd actions.
 *
 * Deliberately transport-independent: the WebSocket class handles reconnection
 * and framing, while every decision about a session lives here so it can be
 * exercised without a socket.
 *
 * :::danger
 * Every entry point is keyed by `sessionId`. Acting on the wrong session would
 * stream one customer's desktop into another's browser.
 * :::
 */

/** Messages this registry emits back to the API. */
export type RdpRegistryOutbound =
  | { type: 'rdp_ready'; sessionId: string; connectionId: string }
  | { type: 'rdp_data'; sessionId: string; data: string }
  | { type: 'rdp_closed'; sessionId: string; reason: string }
  | {
      type: 'error'
      sessionId: string
      message: string
      /**
       * セッションを畳むべきエラーか。
       *
       * :::danger
       * **非致命なら必ず `fatal: false` を載せる。** 省略した場合、受け手は
       * 安全側に倒して致命として扱い、セッションを終了させる。API はこの
       * メッセージを加工せずブラウザへ中継する（`relayToWeb`）ため、ここで
       * 付けた値がそのままブラウザの判断材料になる。
       * :::
       */
      fatal?: boolean
    }

/** Everything the registry needs from its surroundings. */
export interface RdpSessionRegistryOptions {
  /** Opens a transport to guacd. Injected so tests need no real TCP. */
  connect: () => Promise<GuacdSocket>
  /** Sends a message back to the API. */
  send: (msg: RdpRegistryOutbound) => void
}

/** Parameters for opening a session, as received from the API. */
export interface RdpOpenRequest {
  sessionId: string
  /** guacd connection parameters. **Carries credentials.** */
  parameters: Record<string, string>
  width: number
  height: number
  dpi: number
}

export class RdpSessionRegistry {
  private readonly sessions = new Map<string, RdpSession>()

  constructor(private readonly options: RdpSessionRegistryOptions) {}

  /** 登録簿に居るか。API 由来のエラーの宛先判定に使う。 */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * 登録簿から消す。**ただし登録されているのが同じインスタンスのときだけ。**
   *
   * 同一 `sessionId` が再利用されたあとに先行セッションの後始末が届いても、
   * 新しいセッションを巻き添えにしない。
   */
  private deleteIfCurrent(sessionId: string, session: RdpSession): void {
    if (this.sessions.get(sessionId) === session) {
      this.sessions.delete(sessionId)
    }
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size
  }

  /**
   * Open a session and relay it until it closes.
   *
   * Never rejects: a failure is reported to the API as `rdp_closed` so the
   * browser stops waiting. Leaving it to an unhandled rejection would strand
   * the client on a spinner with nothing logged on its side.
   */
  async open(request: RdpOpenRequest): Promise<void> {
    if (this.sessions.has(request.sessionId)) {
      // Reusing a live id would orphan the first guacd socket — it would keep
      // an RDP logon alive with no way left to address it.
      this.options.send({
        type: 'error',
        sessionId: request.sessionId,
        message: 'session id already in use',
      })
      return
    }

    const session = new RdpSession({
      connect: this.options.connect,
      params: {
        protocol: 'rdp',
        parameters: request.parameters,
        optimalWidth: request.width,
        optimalHeight: request.height,
        optimalDpi: request.dpi,
      },
      onOutbound: (data) => {
        this.options.send({
          type: 'rdp_data',
          sessionId: request.sessionId,
          data: Buffer.from(data, 'utf8').toString('base64'),
        })
      },
      onClosed: (reason) => {
        // **自分自身のときだけ消す・通知する。** 閉じた直後に同じ sessionId が
        // 再利用されると、先行セッションの後始末が**新しいセッションを登録簿から
        // 消し**、以降その ID 宛の入力・切断がすべて無視される（画面は出たままなのに
        // 操作が効かなくなる）。通知も同じ ID を宛先にするため、消すだけでなく
        // **送る側にも同じ判定が要る**（送ると生きている画面が切断表示になる）。
        //
        // ここは catch 側と対になる防御であり、**現状の呼び出しグラフでは
        // `ours === false` に到達しない**（onClosed は finish() 経由でのみ発火し、
        // finish() 自体が冪等なため）。テストで殺せない＝効いていることを実証
        // できないコードである点を承知のうえで、catch 側と形を揃えて残している。
        // 実際に到達しうるのは catch 側（rdp-websocket.spec.ts で担保）。
        const ours = this.sessions.get(request.sessionId) === session
        this.deleteIfCurrent(request.sessionId, session)
        if (!ours) return
        this.options.send({
          type: 'rdp_closed',
          sessionId: request.sessionId,
          reason,
        })
      },
      onError: () => {
        // onClosed always follows; reporting here too would double-notify.
      },
    })

    this.sessions.set(request.sessionId, session)

    try {
      const { connectionId } = await session.start()

      // start() also resolves when close() landed mid-handshake — the socket is
      // destroyed and the entry already removed. Reporting ready then would
      // arrive AFTER rdp_closed and leave the browser believing it is connected
      // to a session that no longer exists.
      if (this.sessions.get(request.sessionId) !== session) {
        return
      }

      this.options.send({
        type: 'rdp_ready',
        sessionId: request.sessionId,
        connectionId,
      })
    } catch (error) {
      // 実ソケットでは close() → destroy() → 'close' → ハンドシェイク reject の順で
      // 失敗が**後から**届く。その間に ID が再利用されている可能性がある。
      //
      // :::danger
      // **登録簿の持ち主が自分でなければ、消しも通知もしない。**
      // 「既に onClosed が送った」ケースも「同じ ID を別のセッションが持っている」
      // ケースも、ここに現れる形は同じ「自分はもう持ち主ではない」である。
      // 中断（RdpSessionAbortedError）かどうかの判定だけでは足りない
      // — ハンドシェイク中に close() が入ると、reject は中断ではなく
      // 「ソケットが壊れた」という**通常のエラー**として届くため。
      // :::
      const ours = this.sessions.get(request.sessionId) === session
      this.deleteIfCurrent(request.sessionId, session)
      if (!ours) return
      // The message comes from the handshake, which never embeds parameter
      // values — but keep it to the message alone regardless.
      if (!(error instanceof RdpSessionAbortedError)) {
        this.options.send({
          type: 'rdp_closed',
          sessionId: request.sessionId,
          reason: (error as Error).message,
        })
      }
    }
  }

  /** Forward base64-encoded client input to guacd. */
  send(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const decoded = decodeBase64(data)
    if (decoded === null) {
      // Writing undecodable input would desynchronise guacd's parser for the
      // rest of the session. Log it: silently dropping input presents as
      // "the keyboard stopped working" with nothing to go on.
      this.options.send({
        type: 'error',
        sessionId,
        // guacd 接続もセッションも生きている。捨てたのは 1 フレームだけで、
        // ここで畳むと一時的な不具合のたびに利用者から見て「切断」になる。
        fatal: false,
        message: 'discarded a frame that was not valid base64',
      })
      return
    }
    session.send(decoded)
  }

  /** Tell guacd the client's display size changed. */
  resize(sessionId: string, width: number, height: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.send(
      encodeGuacamoleInstruction('size', [String(width), String(height)]),
    )
  }

  /** Close one session. Safe to call repeatedly. */
  close(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // RdpSession.close() fires onClosed, which removes the entry and reports.
    session.close(reason)
  }

  /**
   * Close every session — the API connection went away, or the agent is
   * shutting down.
   *
   * :::danger
   * **RDP は一時切断をまたいで再開できない。** ターミナルは PTY を生かしたまま
   * 猶予を置ける（`TerminalSessionManager.closeAllGracefully`）が、それが成立
   * するのは出力をリングバッファに溜めて再接続時に再生するからである
   * （`TerminalSession.appendScrollback`）。RDP 側に同等の仕組みは無く、
   * `BaseWebSocketConnection.sendMessage` は WS が OPEN でなければ**黙って
   * 捨てる**。Guacamole の命令列は差分の積み重ねで、`sync` はフレーム境界と
   * フロー制御、`ack` は blob ストリームの結果通知であり、**どちらも欠落した
   * 描画命令を再送させる仕組みではない**。クライアントから再描画を要求する
   * 手段もないため、間を空けて再開すると画面は静かにずれたまま復旧しない。
   *
   * したがって一時切断でも即座に畳み、ブラウザには終了として提示して
   * 張り直させる（画面側に再接続の導線がある）。生かして繋ぎ直すより、
   * 壊れていないことが分かる状態で終わらせる方を採る。
   * :::
   */
  closeAll(reason: string): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.close(sessionId, reason)
    }
  }

}

/**
 * Strict base64 decode.
 *
 * `Buffer.from(x, 'base64')` silently skips invalid characters, so a corrupted
 * frame would decode to plausible-looking bytes and be written straight to
 * guacd. Round-tripping catches that.
 */
function decodeBase64(value: string): string | null {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    return null
  }
  return decoded.toString('utf8')
}
