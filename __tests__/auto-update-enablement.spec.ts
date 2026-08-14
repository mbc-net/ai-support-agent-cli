import { resolveAutoUpdateEnablement } from '../src/auto-update-enablement'

/**
 * 自動アップデートの有効/無効は「CLI フラグ > サーバー設定（管理画面）>
 * ローカル設定 > 既定 OFF」の順で決まる。最初に値が定まった層が勝ち、
 * どの層も値を持たなければ OFF。
 */
describe('resolveAutoUpdateEnablement', () => {
  it('どの層も未指定なら OFF（既定は opt-in）', () => {
    expect(resolveAutoUpdateEnablement({})).toBe(false)
  })

  describe('CLI フラグが最優先', () => {
    it('CLI が ON なら、サーバーもローカルも OFF でも ON', () => {
      expect(
        resolveAutoUpdateEnablement({ cli: true, server: false, local: false }),
      ).toBe(true)
    })

    it('CLI が OFF なら、サーバーもローカルも ON でも OFF', () => {
      expect(
        resolveAutoUpdateEnablement({ cli: false, server: true, local: true }),
      ).toBe(false)
    })
  })

  describe('サーバー設定はローカル設定より優先される', () => {
    it('サーバー ON・ローカル OFF なら ON', () => {
      expect(resolveAutoUpdateEnablement({ server: true, local: false })).toBe(true)
    })

    it('サーバー OFF・ローカル ON なら OFF', () => {
      expect(resolveAutoUpdateEnablement({ server: false, local: true })).toBe(false)
    })
  })

  describe('サーバー設定を取得できない場合はローカル設定へ落ちる', () => {
    it('サーバー未取得・ローカル ON なら ON', () => {
      expect(resolveAutoUpdateEnablement({ server: undefined, local: true })).toBe(
        true,
      )
    })

    it('サーバー未取得・ローカル未設定なら OFF（fail-closed）', () => {
      expect(resolveAutoUpdateEnablement({ server: undefined })).toBe(false)
    })
  })

  it('明示的な false と未指定を取り違えない', () => {
    // local: false は「OFF と決まっている」であり、既定 OFF と結果は同じでも
    // サーバー未取得時の意味づけが違う。ここでは結果の同一性だけを固定する。
    expect(resolveAutoUpdateEnablement({ local: false })).toBe(false)
    expect(resolveAutoUpdateEnablement({ local: undefined })).toBe(false)
  })
})
