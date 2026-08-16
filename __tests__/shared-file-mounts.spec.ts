import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import os from 'os'
import path from 'path'

import { applySharedFileMounts, isSafeMountDestination } from '../src/shared-file-mounts'

/**
 * 共有ファイルをエージェント内へ配置する処理。
 *
 * エージェントは root で動作するため、api 側で検証済みの設定であっても**適用時に再検証**する
 * （api を経由しない経路・改ざん・古い api ビルドを想定した二重防御）。
 * さらにエージェント自身の設定・トークンの置き場は実行環境ごとに異なり api では判定できないため、
 * その禁止はこちら側の責務になる。
 */
describe('isSafeMountDestination', () => {
  const configDir = '/data/.ai-support-agent'

  it.each([
    '/root/.codex/auth.json',
    '/opt/app/config.yaml',
    '/data/app/settings.json',
    '/usr/local/share/ca-certificates/corp.crt',
  ])('許可されたルート配下は通す: %s', (dest) => {
    expect(isSafeMountDestination(dest, configDir)).toBe(true)
  })

  it.each([
    '/etc/myapp/settings.json',
    '/etc/cron.d/job',
    '/usr/local/bin/tool',
    '/bin/sh',
    '/var/lib/app/data',
  ])('許可リストに無い場所は拒否する（api と同じ allowlist）: %s', (dest) => {
    expect(isSafeMountDestination(dest, configDir)).toBe(false)
  })

  it.each(['/root/.ssh/authorized_keys', '/home/user/.ssh/id_rsa'])(
    '許可ルート配下でも .ssh は拒否する: %s',
    (dest) => {
      expect(isSafeMountDestination(dest, configDir)).toBe(false)
    },
  )

  it.each(['', 'relative/path.txt', '/', '/root/.codex/', '/root/../etc/passwd'])(
    '不正なパスは拒否する: %s',
    (dest) => {
      expect(isSafeMountDestination(dest, configDir)).toBe(false)
    },
  )

  it.each(['/etc/passwd', '/etc/shadow', '/etc/sudoers', '/proc/self/environ', '/dev/sda'])(
    'システム上の重要ファイル・特殊ディレクトリは拒否する: %s',
    (dest) => {
      expect(isSafeMountDestination(dest, configDir)).toBe(false)
    },
  )

  describe('正規形でない表記は拒否する（禁止リストの回避防止）', () => {
    it.each([
      '/etc/./passwd',
      '//etc/passwd',
      '/etc//passwd',
      '/etc/ssh/./sshd_config',
      '/root/./a.txt',
      '/root//a.txt',
    ])('%s', (dest) => {
      expect(isSafeMountDestination(dest, configDir)).toBe(false)
    })
  })

  describe('制御文字を含むパスは拒否する', () => {
    it.each(['/root/a\u0000.txt', '/root/a\n.txt'])('%s', (dest) => {
      expect(isSafeMountDestination(dest, configDir)).toBe(false)
    })
  })

  describe('エージェント自身の設定ディレクトリ（api では判定できない）', () => {
    it('設定ディレクトリ配下は拒否する', () => {
      expect(isSafeMountDestination('/data/.ai-support-agent/config.json', configDir)).toBe(false)
      expect(isSafeMountDestination('/data/.ai-support-agent/nested/a.txt', configDir)).toBe(false)
    })

    it('設定ディレクトリそのものも拒否する', () => {
      expect(isSafeMountDestination(configDir, configDir)).toBe(false)
    })

    it('名前が似ているだけの別ディレクトリは許可する', () => {
      expect(isSafeMountDestination('/data/.ai-support-agent-backup/a.txt', configDir)).toBe(true)
    })
  })
})

describe('applySharedFileMounts', () => {
  let tmpDir: string
  const download = jest.fn()

  const deps = () => ({
    downloadToFile: download,
    configDir: path.join(tmpDir, '.ai-support-agent'),
  })

  beforeEach(() => {
    // 配置先は allowlist（/tmp/ 配下など）に含まれる必要があるため、
    // os.tmpdir()（macOS では /var/folders/...）ではなく /tmp を使う。
    tmpDir = mkdtempSync(path.join('/tmp', 'shared-file-mounts-test-'))
    download.mockReset()
    // 既定は「取り寄せたファイルを書き出す」挙動
    download.mockImplementation(async (_sourcePath: string, destination: string) => {
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, 'content-v1')
    })
  })

  it('設定に従ってファイルを配置する', async () => {
    const dest = path.join(tmpDir, 'root/.codex/auth.json')

    const results = await applySharedFileMounts(
      [{ sourcePath: 'codex/auth.json', destPath: dest }],
      deps(),
    )

    expect(readFileSync(dest, 'utf-8')).toBe('content-v1')
    expect(results).toEqual([{ destPath: dest, status: 'applied' }])
  })

  it('親ディレクトリが無ければ作成する', async () => {
    const dest = path.join(tmpDir, 'a/b/c/file.txt')

    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())

    expect(readFileSync(dest, 'utf-8')).toBe('content-v1')
  })

  it('パーミッションは既定で 0600（秘密情報を想定した最小権限）', async () => {
    const dest = path.join(tmpDir, 'secret.txt')

    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())

    expect(statSync(dest).mode & 0o777).toBe(0o600)
  })

  it('mode を指定するとその権限で配置する', async () => {
    const dest = path.join(tmpDir, 'public.txt')

    await applySharedFileMounts(
      [{ sourcePath: 'a.txt', destPath: dest, mode: '0644' }],
      deps(),
    )

    expect(statSync(dest).mode & 0o777).toBe(0o644)
  })

  it('内容が同じ場合は書き換えない（skipped を返す）', async () => {
    const dest = path.join(tmpDir, 'same.txt')
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, 'content-v1', { mode: 0o600 })

    const results = await applySharedFileMounts(
      [{ sourcePath: 'a.txt', destPath: dest }],
      deps(),
    )

    expect(results).toEqual([{ destPath: dest, status: 'skipped' }])
  })

  it('内容が変わっていれば置き換える', async () => {
    const dest = path.join(tmpDir, 'changed.txt')
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, 'old-content', { mode: 0o600 })

    const results = await applySharedFileMounts(
      [{ sourcePath: 'a.txt', destPath: dest }],
      deps(),
    )

    expect(readFileSync(dest, 'utf-8')).toBe('content-v1')
    expect(results[0].status).toBe('applied')
  })

  it('配置先が不正な設定は適用せず failed を返す（api を信用しない）', async () => {
    const results = await applySharedFileMounts(
      [{ sourcePath: 'a.txt', destPath: '/etc/passwd' }],
      deps(),
    )

    expect(results[0].status).toBe('failed')
    expect(results[0].error).toMatch(/配置先/)
    expect(download).not.toHaveBeenCalled()
  })

  it('取得に失敗しても他のファイルの配置は続ける（部分失敗を握り潰さない）', async () => {
    const okDest = path.join(tmpDir, 'ok.txt')
    const ngDest = path.join(tmpDir, 'ng.txt')
    download.mockImplementation(async (sourcePath: string, destination: string) => {
      if (sourcePath === 'ng.txt') throw new Error('403 Forbidden')
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, 'content-v1')
    })

    const results = await applySharedFileMounts(
      [
        { sourcePath: 'ng.txt', destPath: ngDest },
        { sourcePath: 'ok.txt', destPath: okDest },
      ],
      deps(),
    )

    expect(results[0].status).toBe('failed')
    expect(results[0].error).toContain('403')
    expect(results[1].status).toBe('applied')
    expect(readFileSync(okDest, 'utf-8')).toBe('content-v1')
  })

  describe('シンボリックリンク経由の書き込みを拒否する', () => {
    it('配置先が既にシンボリックリンクなら適用しない（リンク先を書き換えない）', async () => {
      const victim = path.join(tmpDir, 'victim.txt')
      writeFileSync(victim, 'do-not-touch')
      const dest = path.join(tmpDir, 'link.json')
      symlinkSync(victim, dest)

      const results = await applySharedFileMounts(
        [{ sourcePath: 'a.txt', destPath: dest }],
        deps(),
      )

      expect(results[0].status).toBe('failed')
      expect(readFileSync(victim, 'utf-8')).toBe('do-not-touch')
    })

    it('親ディレクトリのリンクが危険な場所を指す場合は適用しない', async () => {
      // /etc へ逃がすリンクを親に仕込むケース。経路にリンクがあること自体ではなく、
      // 「解決先が許可されない場所か」で判定する（macOS の /var → /private/var の
      // ような正当な構成を弾かないため）。
      const linkDir = path.join(tmpDir, 'escape')
      symlinkSync('/etc/ssh', linkDir)

      const results = await applySharedFileMounts(
        [{ sourcePath: 'a.txt', destPath: path.join(linkDir, 'authorized_keys') }],
        deps(),
      )

      expect(results[0].status).toBe('failed')
      // 検証で弾けていることを確かめる。取得まで進んでいる場合、テストは非 root
      // 実行の権限エラーで「たまたま」失敗しているだけで、root 実行の本番では
      // 書き込めてしまう。
      expect(download).not.toHaveBeenCalled()
    })

    it('危険な場所そのもの（/etc）を指すリンクも適用しない', async () => {
      // 解決先が /etc「配下」ではなく /etc「ちょうど」になるケース。
      // 配置先のファイル名を解決先に含め忘れると、判定対象が /etc となり、
      // 末尾スラッシュ付きの前方一致（/etc/）をすり抜ける。
      const linkDir = path.join(tmpDir, 'to-etc')
      symlinkSync('/etc', linkDir)

      const results = await applySharedFileMounts(
        [{ sourcePath: 'a.txt', destPath: path.join(linkDir, 'ld.so.preload') }],
        deps(),
      )

      expect(results[0].status).toBe('failed')
      expect(download).not.toHaveBeenCalled()
    })

    it('許可されたルートの外を指すリンクは適用しない（危険リストに載っていなくても）', async () => {
      // 「危険な場所を数え上げて塞ぐ」方式では守り切れないため、解決先も
      // 許可リスト方式で判定する。/usr/share は危険リストには無いが許可もされない。
      const linkDir = path.join(tmpDir, 'to-usr-share')
      symlinkSync('/usr/share', linkDir)

      const results = await applySharedFileMounts(
        [{ sourcePath: 'a.txt', destPath: path.join(linkDir, 'a.txt') }],
        deps(),
      )

      expect(results[0].status).toBe('failed')
      expect(download).not.toHaveBeenCalled()
    })

    it('配置先が他のファイルへのハードリンクなら適用しない（実体の書き換え・権限変更を防ぐ）', async () => {
      // ハードリンクはシンボリックリンクと違い lstat で見分けられないが、
      // 内容が一致すると「同じなので mode だけ合わせる」経路に入り、
      // リンク先の実体（機密ファイル）のパーミッションを書き換えてしまう。
      const victim = path.join(tmpDir, 'victim.txt')
      writeFileSync(victim, 'content-v1', { mode: 0o600 })
      const dest = path.join(tmpDir, 'hardlink.txt')
      linkSync(victim, dest)

      const results = await applySharedFileMounts(
        [{ sourcePath: 'a.txt', destPath: dest, mode: '0644' }],
        deps(),
      )

      expect(results[0].status).toBe('failed')
      expect(statSync(victim).mode & 0o777).toBe(0o600)
    })

    it('リンクの解決先が SSH の設定ディレクトリなら適用しない', async () => {
      // 宣言上のパスに .ssh が無くても、リンクの先が .ssh なら同じこと
      // （authorized_keys を置ければそのままログインを許してしまう）。
      const sshDir = path.join(tmpDir, '.ssh')
      mkdirSync(sshDir, { recursive: true })
      const linkDir = path.join(tmpDir, 'keys')
      symlinkSync(sshDir, linkDir)

      const results = await applySharedFileMounts(
        [{ sourcePath: 'a.txt', destPath: path.join(linkDir, 'authorized_keys') }],
        deps(),
      )

      expect(results[0].status).toBe('failed')
      expect(download).not.toHaveBeenCalled()
    })

    it('親ディレクトリのリンクが安全な場所を指す場合は実体へ配置する', async () => {
      const realDir = path.join(tmpDir, 'real')
      mkdirSync(realDir, { recursive: true })
      const linkDir = path.join(tmpDir, 'linked')
      symlinkSync(realDir, linkDir)

      const results = await applySharedFileMounts(
        [{ sourcePath: 'a.txt', destPath: path.join(linkDir, 'a.txt') }],
        deps(),
      )

      expect(results[0].status).toBe('applied')
      expect(readFileSync(path.join(realDir, 'a.txt'), 'utf-8')).toBe('content-v1')
    })
  })

  it('一時ファイルは呼び出しごとに異なる場所へ作る（並行実行での取り違え防止）', async () => {
    const seen: string[] = []
    download.mockImplementation(async (_s: string, destination: string) => {
      seen.push(destination)
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, 'content-v1')
    })

    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: path.join(tmpDir, 'x.txt') }], deps())
    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: path.join(tmpDir, 'x.txt') }], deps())

    expect(seen[0]).not.toBe(seen[1])
  })

  it('内容が同じでも mode が違えば直す（権限だけ変えた設定を反映する）', async () => {
    const dest = path.join(tmpDir, 'perm.txt')
    writeFileSync(dest, 'content-v1', { mode: 0o644 })

    const results = await applySharedFileMounts(
      [{ sourcePath: 'a.txt', destPath: dest, mode: '0600' }],
      deps(),
    )

    expect(statSync(dest).mode & 0o777).toBe(0o600)
    expect(results[0].status).toBe('applied')
  })

  it('親ディレクトリは 0700 で作る（秘密情報の置き場を他ユーザーに見せない）', async () => {
    const dest = path.join(tmpDir, 'newdir/secret.txt')

    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())

    expect(statSync(path.dirname(dest)).mode & 0o777).toBe(0o700)
  })

  describe('大きなファイル（ハッシュ計算をメモリへ載せない）', () => {
    // 「数百MB を想定」する取得経路に合わせ、比較のためのハッシュ計算も
    // 全量をメモリへ載せない実装であることを、実サイズのファイルで確かめる。
    const largeContent = 'x'.repeat(8 * 1024 * 1024) // 8MB

    beforeEach(() => {
      download.mockImplementation(async (_s: string, destination: string) => {
        mkdirSync(path.dirname(destination), { recursive: true })
        writeFileSync(destination, largeContent)
      })
    })

    it('配置できる', async () => {
      const dest = path.join(tmpDir, 'large.bin')

      const results = await applySharedFileMounts(
        [{ sourcePath: 'large.bin', destPath: dest }],
        deps(),
      )

      expect(results[0].status).toBe('applied')
      expect(statSync(dest).size).toBe(largeContent.length)
    })

    it('ハッシュ計算でファイル全体をメモリへ読み込まない（readFileSync を使わない）', async () => {
      const dest = path.join(tmpDir, 'large.bin')
      const fs = jest.requireActual('fs') as typeof import('fs')
      const spy = jest.spyOn(fs, 'readFileSync')

      try {
        await applySharedFileMounts(
          [{ sourcePath: 'large.bin', destPath: dest }],
          deps(),
        )

        // 取得（downloadToFile）はテスト側のモックなので対象外。
        // 実装が配置先・一時ファイルを readFileSync で丸ごと読んでいないことを見る
        // （配置の記録は小さな JSON なので対象から外す）。
        const readTargets = spy.mock.calls
          .map((call) => String(call[0]))
          .filter(
            (target) =>
              target.startsWith(tmpDir) &&
              !target.endsWith('shared-file-mounts.json'),
          )
        expect(readTargets).toEqual([])
      } finally {
        spy.mockRestore()
      }
    })

    it('2 回目は内容が同じと判定してスキップする（ハッシュ比較が正しく働く）', async () => {
      const dest = path.join(tmpDir, 'large.bin')
      await applySharedFileMounts([{ sourcePath: 'large.bin', destPath: dest }], deps())

      const results = await applySharedFileMounts(
        [{ sourcePath: 'large.bin', destPath: dest }],
        deps(),
      )

      expect(results[0].status).toBe('skipped')
    })
  })

  it('エージェント自身の設定ディレクトリへリンクで逃がす経路も拒否する', async () => {
    // 解決先の判定（宣言パスの allowlist とは別の規則）を通す経路。
    const configDir = path.join(tmpDir, '.ai-support-agent')
    mkdirSync(configDir, { recursive: true })
    const linkDir = path.join(tmpDir, 'to-config')
    symlinkSync(configDir, linkDir)

    const results = await applySharedFileMounts(
      [{ sourcePath: 'a.txt', destPath: path.join(linkDir, 'config.json') }],
      { downloadToFile: download, configDir },
    )

    expect(results[0].status).toBe('failed')
    expect(existsSync(path.join(configDir, 'config.json'))).toBe(false)
  })

  it('取得したファイルが消えている場合もエラーとして返す（ハッシュ計算の失敗）', async () => {
    download.mockImplementation(async () => {
      // 取得したように見せて何も書かない（ネットワーク断等で起こり得る）
    })

    const results = await applySharedFileMounts(
      [{ sourcePath: 'a.txt', destPath: path.join(tmpDir, 'missing.txt') }],
      deps(),
    )

    expect(results[0].status).toBe('failed')
  })

  it('前後に空白が付いたパスは拒否する（検証と書き込みで別の文字列にならないように）', async () => {
    // 空白を落として判定すると、判定は絶対パスとして通るのに、fs 層は元の文字列を
    // 相対パスとして解決してしまう（作業ディレクトリ配下へ書かれる）。
    const results = await applySharedFileMounts(
      [{ sourcePath: 'a.txt', destPath: ` ${path.join(tmpDir, 'space.txt')} ` }],
      deps(),
    )

    expect(results[0].status).toBe('failed')
    expect(download).not.toHaveBeenCalled()
  })

  it('設定が空なら何もしない', async () => {
    expect(await applySharedFileMounts([], deps())).toEqual([])
    expect(await applySharedFileMounts(undefined, deps())).toEqual([])
    expect(download).not.toHaveBeenCalled()
  })

  it('失敗しても例外を投げない（エージェントの起動を止めない）', async () => {
    download.mockRejectedValue(new Error('network down'))

    await expect(
      applySharedFileMounts([{ sourcePath: 'a.txt', destPath: path.join(tmpDir, 'x.txt') }], deps()),
    ).resolves.toBeDefined()
  })
})

/**
 * 設定から外れた配置先の後始末。
 *
 * 配置しっぱなしだと、漏洩に気づいて設定を消しても認証情報がエージェント内に残り、
 * 失効・ローテーションが実効的に機能しない（`/data` は PVC のため Pod を作り直しても
 * 消えない）。自分が置いたものだけを、置いたときのまま残っている場合に限り削除する。
 */
describe('applySharedFileMounts（設定から外れた配置先の削除）', () => {
  let tmpDir: string
  let configDir: string
  let download: jest.Mock

  const deps = () => ({ downloadToFile: download, configDir })

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join('/tmp', 'shared-file-cleanup-test-'))
    configDir = path.join(tmpDir, '.ai-support-agent')
    mkdirSync(configDir, { recursive: true })
    download = jest.fn(async (_sourcePath: string, destination: string) => {
      mkdirSync(path.dirname(destination), { recursive: true })
      writeFileSync(destination, 'content-v1')
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('設定から消えた配置先を削除する', async () => {
    const dest = path.join(tmpDir, 'gone.txt')
    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())
    expect(existsSync(dest)).toBe(true)

    const results = await applySharedFileMounts([], deps())

    expect(existsSync(dest)).toBe(false)
    expect(results).toEqual([
      expect.objectContaining({ destPath: dest, status: 'removed' }),
    ])
  })

  it('機能が無効化されて空配列が配信された場合は削除する', async () => {
    // api は「機能が無効・設定なし」を空配列で明示する。
    const dest = path.join(tmpDir, 'disabled.txt')
    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())

    await applySharedFileMounts([], deps())

    expect(existsSync(dest)).toBe(false)
  })

  it('設定が配信されていない（判断材料が無い）場合は削除しない', async () => {
    // undefined は「設定が空」ではなく「今回は分からない」を意味する。
    // 設定取得に失敗してキャッシュへ退避した場合や、機能判定が一時的に失敗した場合、
    // 古い api と通信している場合に起こる。ここで消すと、単なる通信障害で
    // 動いていた認証情報を失う。
    const dest = path.join(tmpDir, 'unknown.txt')
    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())

    const results = await applySharedFileMounts(undefined, deps())

    expect(existsSync(dest)).toBe(true)
    expect(results).toEqual([])
  })

  it('判断材料が無い間も記録は失わない（配信が戻れば削除できる）', async () => {
    const dest = path.join(tmpDir, 'later.txt')
    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())
    await applySharedFileMounts(undefined, deps())

    const results = await applySharedFileMounts([], deps())

    expect(existsSync(dest)).toBe(false)
    expect(results).toEqual([
      expect.objectContaining({ destPath: dest, status: 'removed' }),
    ])
  })

  it('残っている配置先は削除しない', async () => {
    const keep = path.join(tmpDir, 'keep.txt')
    const drop = path.join(tmpDir, 'drop.txt')
    await applySharedFileMounts(
      [
        { sourcePath: 'a.txt', destPath: keep },
        { sourcePath: 'a.txt', destPath: drop },
      ],
      deps(),
    )

    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: keep }], deps())

    expect(existsSync(keep)).toBe(true)
    expect(existsSync(drop)).toBe(false)
  })

  it('配置後に書き換えられたファイルは削除せず、理由を報告する', async () => {
    // 自分が置いたものと違う内容＝別の誰か（利用者・他の仕組み）が更新している。
    // 勝手に消すとその変更を失うため、消さずに報告して判断を委ねる。
    const dest = path.join(tmpDir, 'modified.txt')
    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())
    writeFileSync(dest, 'edited-by-someone-else')

    const results = await applySharedFileMounts([], deps())

    expect(existsSync(dest)).toBe(true)
    expect(results[0].status).toBe('failed')
    expect(readFileSync(dest, 'utf-8')).toBe('edited-by-someone-else')
  })

  it('削除に成功した配置先は次回以降報告しない', async () => {
    const dest = path.join(tmpDir, 'once.txt')
    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())
    await applySharedFileMounts([], deps())

    const results = await applySharedFileMounts([], deps())

    expect(results).toEqual([])
  })

  it('設定に残っているものは、取得に失敗しても削除しない', async () => {
    // 一時的なネットワーク障害で取得できなかっただけの配置先を消してしまうと、
    // 動いていた認証情報が失われ、障害を自分で拡大することになる。
    const dest = path.join(tmpDir, 'still-configured.txt')
    const mounts = [{ sourcePath: 'a.txt', destPath: dest }]
    await applySharedFileMounts(mounts, deps())

    download.mockRejectedValue(new Error('network error'))
    const results = await applySharedFileMounts(mounts, deps())

    expect(existsSync(dest)).toBe(true)
    expect(results.every((r) => r.status !== 'removed')).toBe(true)
  })

  it('取得に失敗した配置先の記録は残す（次回に後始末できるように）', async () => {
    const dest = path.join(tmpDir, 'record-kept.txt')
    const mounts = [{ sourcePath: 'a.txt', destPath: dest }]
    await applySharedFileMounts(mounts, deps())

    download.mockRejectedValue(new Error('network error'))
    await applySharedFileMounts(mounts, deps())

    // 設定から外れたら、記録が残っているので削除できる
    download.mockClear()
    const results = await applySharedFileMounts([], deps())

    expect(existsSync(dest)).toBe(false)
    expect(results).toEqual([
      expect.objectContaining({ destPath: dest, status: 'removed' }),
    ])
  })

  it('削除に失敗したら報告し、記録も残す（次回に再試行できるように）', async () => {
    const lockedDir = path.join(tmpDir, 'locked')
    mkdirSync(lockedDir, { recursive: true })
    const dest = path.join(lockedDir, 'stuck.txt')
    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())

    // 親ディレクトリの書き込みを禁じると unlink できない
    chmodSync(lockedDir, 0o500)
    try {
      const results = await applySharedFileMounts([], deps())

      expect(results[0].status).toBe('failed')
      expect(existsSync(dest)).toBe(true)
    } finally {
      chmodSync(lockedDir, 0o700)
    }

    // 記録が残っているので、権限が戻れば次回削除できる
    const retry = await applySharedFileMounts([], deps())
    expect(retry).toEqual([
      expect.objectContaining({ destPath: dest, status: 'removed' }),
    ])
  })

  it('自分が置いていないファイルは削除しない', async () => {
    const foreign = path.join(tmpDir, 'not-ours.txt')
    writeFileSync(foreign, 'not-ours')

    await applySharedFileMounts([], deps())

    expect(existsSync(foreign)).toBe(true)
  })

  it('記録が改ざんされて許可されない場所を指していても削除しない', async () => {
    // 記録は設定ディレクトリ内のファイルにすぎない。書き換えられた場合に
    // 任意のファイルを root 権限で消せる経路にならないよう、削除前にも検証する。
    const victim = path.join(tmpDir, 'victim.txt')
    writeFileSync(victim, 'content-v1')
    const manifestPath = path.join(configDir, 'shared-file-mounts.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        mounts: [
          { destPath: '/etc/passwd', hash: 'x' },
          { destPath: ' /root/a.txt', hash: 'x' },
        ],
      }),
    )

    const results = await applySharedFileMounts([], deps())

    expect(existsSync(victim)).toBe(true)
    expect(results.every((r) => r.status !== 'removed')).toBe(true)
  })

  it('同時に呼ばれても記録が壊れない（直列に処理する）', async () => {
    // 設定同期はデバウンス経由と WebSocket 通知の両方から起動され得るため、
    // 重なった場合に記録の読み書きが競合しないことを保証する。
    const first = path.join(tmpDir, 'concurrent-1.txt')
    const second = path.join(tmpDir, 'concurrent-2.txt')

    await Promise.all([
      applySharedFileMounts([{ sourcePath: 'a.txt', destPath: first }], deps()),
      applySharedFileMounts([{ sourcePath: 'a.txt', destPath: second }], deps()),
    ])

    // 後から実行された側の設定が記録に残る（先に消えた側は削除されている）。
    // どちらが後かは競合次第だが、記録と実ファイルは必ず一致する。
    const manifest = JSON.parse(
      readFileSync(path.join(configDir, 'shared-file-mounts.json'), 'utf-8'),
    )
    const recorded = manifest.mounts.map((m: { destPath: string }) => m.destPath)
    for (const dest of [first, second]) {
      expect(existsSync(dest)).toBe(recorded.includes(dest))
    }
  })

  it('記録が壊れていても例外を投げない（起動を止めない）', async () => {
    writeFileSync(path.join(configDir, 'shared-file-mounts.json'), 'not-json')

    await expect(
      applySharedFileMounts([{ sourcePath: 'a.txt', destPath: path.join(tmpDir, 'a.txt') }], deps()),
    ).resolves.toBeDefined()
  })

  it('記録が壊れている場合は報告し、記録を上書きしない（追跡不能を黙って作らない）', async () => {
    // 「読めない＝何も置いていない」とみなして上書きすると、過去に置いた認証情報を
    // 二度と後始末できなくなる。画面に出したうえで、残っている情報も壊さない。
    const manifestFile = path.join(configDir, 'shared-file-mounts.json')
    writeFileSync(manifestFile, '{"mounts": [broken')

    const results = await applySharedFileMounts([], deps())

    expect(results).toEqual([
      expect.objectContaining({ destPath: '(manifest)', status: 'failed' }),
    ])
    expect(readFileSync(manifestFile, 'utf-8')).toBe('{"mounts": [broken')
  })

  it('記録を保存できない場合も報告する（次回の後始末ができなくなるため）', async () => {
    const dest = path.join(tmpDir, 'a.txt')
    chmodSync(configDir, 0o500)

    try {
      const results = await applySharedFileMounts(
        [{ sourcePath: 'a.txt', destPath: dest }],
        deps(),
      )

      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ destPath: '(manifest)', status: 'failed' }),
        ]),
      )
    } finally {
      chmodSync(configDir, 0o700)
    }
  })

  it('記録に無い既存ファイルは、内容が一致しても自分のものとして扱わない', async () => {
    // 第三者が用意したファイルとたまたま内容が一致しただけの場合に、
    // 後で設定から外れたときにそれを削除してしまうのを防ぐ。
    const dest = path.join(tmpDir, 'pre-existing.txt')
    writeFileSync(dest, 'content-v1')

    await applySharedFileMounts([{ sourcePath: 'a.txt', destPath: dest }], deps())
    await applySharedFileMounts([], deps())

    expect(existsSync(dest)).toBe(true)
  })
})
