import { execFileSync } from 'child_process'

import {
  ensureGuacdContainer,
  GUACD_CONTAINER_NAME,
  GUACD_NETWORK_NAME,
  stopGuacdContainer,
} from '../../src/rdp/guacd-container'

jest.mock('child_process', () => ({ execFileSync: jest.fn() }))
jest.mock('../../src/docker/docker-utils', () => ({
  getDockerPath: () => '/usr/bin/docker',
}))

/**
 * guacd を Docker コンテナとして起動・停止する。
 *
 * K8s / ECS は宣言的なマニフェストでサイドカーを組めるが、Docker 形態と CLI
 * 直起動にはサイドカーの仕組みが無いため、エージェント自身が面倒を見る。
 *
 * :::danger
 * **guacd には認証が無い。** 到達できる者は誰でも任意のホストへ RDP 接続を
 * 張れる。公開する場合も必ず `127.0.0.1` に束縛し、`0.0.0.0` へ出さない。
 * :::
 */

const exec = execFileSync as jest.Mock

/** docker に渡された引数列を取り出す。 */
function calls(): string[][] {
  return exec.mock.calls.map((c) => c[1] as string[])
}

/** 特定のサブコマンドの呼び出しを探す。 */
function callFor(sub: string): string[] | undefined {
  return calls().find((args) => args[0] === sub)
}

describe('ensureGuacdContainer', () => {
  beforeEach(() => {
    exec.mockReset()
    // 既定: 稼働中のコンテナは無い（inspect は失敗する）
    exec.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'inspect') throw new Error('No such object')
      return ''
    })
  })

  describe('ループバック公開モード（CLI 直起動）', () => {
    it('guacd を起動して接続先を返す', () => {
      const result = ensureGuacdContainer({ mode: 'loopback' })
      expect(result).toEqual({ host: '127.0.0.1', port: 4822 })
    })

    it('★ 127.0.0.1 に束縛して公開する（0.0.0.0 へ出さない）', () => {
      ensureGuacdContainer({ mode: 'loopback' })
      const run = callFor('run')
      expect(run).toContain('-p')
      const publish = run?.[run.indexOf('-p') + 1]
      expect(publish).toBe('127.0.0.1:4822:4822')
      expect(run?.join(' ')).not.toContain('0.0.0.0')
    })

    it('バックグラウンドで起動し、停止時に自動削除する', () => {
      ensureGuacdContainer({ mode: 'loopback' })
      const run = callFor('run')
      expect(run).toContain('-d')
      expect(run).toContain('--rm')
    })

    it('決まった名前を付ける（再利用と後始末のため）', () => {
      ensureGuacdContainer({ mode: 'loopback' })
      const run = callFor('run')
      expect(run?.[run.indexOf('--name') + 1]).toBe(GUACD_CONTAINER_NAME)
    })
  })

  describe('ネットワークモード（Docker 形態）', () => {
    it('ネットワーク上のホスト名を返す', () => {
      const result = ensureGuacdContainer({ mode: 'network' })
      expect(result).toEqual({ host: GUACD_CONTAINER_NAME, port: 4822 })
    })

    it('専用ネットワークを用意する', () => {
      ensureGuacdContainer({ mode: 'network' })
      const create = calls().find(
        (args) => args[0] === 'network' && args[1] === 'create',
      )
      expect(create).toContain(GUACD_NETWORK_NAME)
    })

    it('★ ポートを公開しない（同一ネットワーク内からのみ到達させる）', () => {
      ensureGuacdContainer({ mode: 'network' })
      const run = callFor('run')
      expect(run).not.toContain('-p')
    })

    it('ネットワークへ接続して起動する', () => {
      ensureGuacdContainer({ mode: 'network' })
      const run = callFor('run')
      expect(run?.[run.indexOf('--network') + 1]).toBe(GUACD_NETWORK_NAME)
    })

    it('ネットワークが既にあってもエラーにしない', () => {
      exec.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect') throw new Error('No such object')
        if (args[0] === 'network' && args[1] === 'create') {
          throw new Error('network already exists')
        }
        return ''
      })
      expect(() => ensureGuacdContainer({ mode: 'network' })).not.toThrow()
    })
  })

  describe('冪等性', () => {
    it('★ 既に稼働中なら再起動しない', () => {
      exec.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect') return 'true\n'
        return ''
      })
      ensureGuacdContainer({ mode: 'loopback' })
      expect(callFor('run')).toBeUndefined()
    })

    it('停止した同名コンテナが残っていれば消してから起動する', () => {
      exec.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'inspect') return 'false\n'
        return ''
      })
      ensureGuacdContainer({ mode: 'loopback' })
      expect(callFor('rm')).toContain(GUACD_CONTAINER_NAME)
      expect(callFor('run')).toBeDefined()
    })
  })

  it('イメージを上書きできる', () => {
    ensureGuacdContainer({ mode: 'loopback', image: 'registry/guacd:1.5.5' })
    expect(callFor('run')).toContain('registry/guacd:1.5.5')
  })

  it('版固定の既定イメージを使う', () => {
    ensureGuacdContainer({ mode: 'loopback' })
    const image = callFor('run')?.find((a) => a.startsWith('guacamole/guacd'))
    expect(image).toMatch(/^guacamole\/guacd:\d+\.\d+\.\d+$/)
  })

  it('★ 起動に失敗したら握り潰さずに投げる', () => {
    exec.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'inspect') throw new Error('No such object')
      if (args[0] === 'run') throw new Error('no such image')
      return ''
    })
    // 黙って続けると、エージェントは存在しない guacd へ延々と接続を試みる。
    expect(() => ensureGuacdContainer({ mode: 'loopback' })).toThrow(
      /guacd/,
    )
  })
})

describe('stopGuacdContainer', () => {
  beforeEach(() => {
    exec.mockReset()
    exec.mockImplementation(() => '')
  })

  it('コンテナを停止する', () => {
    stopGuacdContainer()
    expect(callFor('stop')).toContain(GUACD_CONTAINER_NAME)
  })

  it('★ 停止に失敗しても呼び出し元を止めない（終了処理を壊さない）', () => {
    exec.mockImplementation(() => {
      throw new Error('No such container')
    })
    expect(() => stopGuacdContainer()).not.toThrow()
  })
})
