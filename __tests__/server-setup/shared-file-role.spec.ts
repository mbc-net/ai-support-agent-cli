import { readFileSync } from 'fs'
import * as path from 'path'

import { load } from 'js-yaml'

import { SHARED_FILE_STAGING_DIR_VAR } from '../../src/server-setup/shared-file-staging'

/**
 * shared_file bundled role（agent/ansible/roles/shared_file）の静的検証。
 *
 * このロールは、プロジェクトの共有ファイルにアップロード済みのファイル／フォルダを
 * 対象サーバーの指定パスへ配置する。レシピ本体では `ansible.builtin.copy` の `src`
 * （コントローラ側ローカルパス）を禁止している——許すとエージェント自身のトークンや
 * SSH 秘密鍵を配布できてしまうため——ので、その安全な代替がこのロールである。
 *
 * 実体の転送はエージェントが実行前に行うステージング（shared-file-staging.ts）に依存する。
 * ここでは jest で検証できる範囲として
 * (1) 既定値、(2) タスク構造、(3) 秘匿の取り回し、(4) ステージング外へ出られないこと
 * を固定する。
 */
describe('shared_file bundled role', () => {
  const roleDir = path.join(__dirname, '..', '..', 'ansible', 'roles', 'shared_file')

  function readRaw(...segments: string[]): string {
    return readFileSync(path.join(roleDir, ...segments), 'utf8')
  }

  function loadYaml(...segments: string[]): unknown {
    return load(readRaw(...segments))
  }

  type Task = Record<string, any>

  function tasks(): Task[] {
    return loadYaml('tasks', 'main.yml') as Task[]
  }

  function flatten(list: Task[]): Task[] {
    const out: Task[] = []
    const walk = (items: Task[]): void => {
      for (const task of items) {
        out.push(task)
        for (const key of ['block', 'rescue', 'always']) {
          if (Array.isArray(task[key])) walk(task[key])
        }
      }
    }
    walk(list)
    return out
  }

  function defaults(): Record<string, unknown> {
    return loadYaml('defaults', 'main.yml') as Record<string, unknown>
  }

  describe('defaults/main.yml', () => {
    it('必須値（src / dest）は既定を持たない', () => {
      // 既定を持たせると、指定漏れが「意図しないファイルを意図しない場所へ置く」
      // 形で成立してしまう。空にして assert で名指しさせる。
      expect(defaults().shared_file_src).toBe('')
      expect(defaults().shared_file_dest).toBe('')
    })

    it('所有者・パーミッションの既定は root:root / 0644（ディレクトリは 0755）', () => {
      expect(defaults().shared_file_owner).toBe('root')
      expect(defaults().shared_file_group).toBe('root')
      expect(defaults().shared_file_mode).toBe('0644')
      expect(defaults().shared_file_directory_mode).toBe('0755')
    })

    it('ステージングディレクトリの既定は空（エージェントが extra-vars で渡す）', () => {
      expect(defaults()[SHARED_FILE_STAGING_DIR_VAR]).toBe('')
    })
  })

  describe('tasks/main.yml の構造', () => {
    it('必須変数を assert で検証する', () => {
      const asserts = flatten(tasks()).filter((t) => t['ansible.builtin.assert'])
      const conditions = asserts
        .flatMap((t) => t['ansible.builtin.assert'].that as string[])
        .join('\n')

      expect(conditions).toContain('shared_file_src')
      expect(conditions).toContain('shared_file_dest')
      expect(conditions).toContain(SHARED_FILE_STAGING_DIR_VAR)
    })

    it('dest が絶対パスであることを assert する', () => {
      const conditions = flatten(tasks())
        .filter((t) => t['ansible.builtin.assert'])
        .flatMap((t) => t['ansible.builtin.assert'].that as string[])
        .join('\n')

      expect(conditions).toMatch(/shared_file_dest.*match\(|shared_file_dest.*\^\//)
    })

    it('配置タスクは copy を使い、src はステージングディレクトリ配下から組み立てる', () => {
      const copies = flatten(tasks()).filter((t) => t['ansible.builtin.copy'])
      expect(copies.length).toBeGreaterThan(0)
      for (const task of copies) {
        expect(String(task['ansible.builtin.copy'].src)).toContain(
          SHARED_FILE_STAGING_DIR_VAR,
        )
      }
    })

    it('src の組み立てに使う相対パスは shared_file_src のみ（他の変数を混ぜない）', () => {
      // ステージング配下から出られないことを、src 式の形で固定する。
      const copies = flatten(tasks()).filter((t) => t['ansible.builtin.copy'])
      for (const task of copies) {
        const src = String(task['ansible.builtin.copy'].src)
        const referenced = [...src.matchAll(/\b(shared_file_[a-z_]+)\b/g)].map(
          (m) => m[1],
        )
        for (const name of referenced) {
          expect([
            'shared_file_src',
            SHARED_FILE_STAGING_DIR_VAR,
            'shared_file_staged',
          ]).toContain(name)
        }
      }
    })

    it('配置タスクに no_log を付けない（保護にならず失敗理由だけを消すため）', () => {
      // 配布物には秘密鍵が含まれ得るが、`copy` は `src` で渡したファイルの中身を
      // 出力しない。唯一の経路である diff 出力は runner が ansible.cfg の
      // `[diff] always = False` と `ANSIBLE_DIFF_ALWAYS` の無効化で塞いでいる。
      // 一方 no_log は失敗時に結果全体を censored に置き換えて msg ごと消すため、
      // 付けると「タスク名しか分からない失敗」を作るだけになる
      // （ansible-roles-no-log-diagnostics.spec.ts が全ロールで禁じている規約）。
      const copies = flatten(tasks()).filter((t) => t['ansible.builtin.copy'])
      expect(copies.length).toBeGreaterThan(0)
      for (const task of copies) {
        expect(task.no_log).toBeUndefined()
      }
    })

    it('ファイル内容が出力される唯一の経路（diff）は runner 側で塞がれている', () => {
      // ロール単体では防げないため、対になる防御が実在することをここで固定する。
      // どちらかが失われたら、秘密鍵の内容が実行ログへ出る。
      const runner = readFileSync(
        path.join(__dirname, '..', '..', 'src', 'server-setup', 'server-setup-runner.ts'),
        'utf8',
      )
      expect(runner).toContain('ANSIBLE_DIFF_ALWAYS: undefined')
      expect(runner).toContain('always = False')
    })

    it('owner / group / mode / directory_mode を copy へ渡す', () => {
      const copy = flatten(tasks()).find((t) => t['ansible.builtin.copy'])!
      const args = copy['ansible.builtin.copy']
      expect(String(args.owner)).toContain('shared_file_owner')
      expect(String(args.group)).toContain('shared_file_group')
      expect(String(args.mode)).toContain('shared_file_mode')
      expect(String(args.directory_mode)).toContain('shared_file_directory_mode')
    })

    it('配置先ディレクトリが無ければ作成する（copy は親ディレクトリを作らない）', () => {
      const dirTasks = flatten(tasks()).filter(
        (t) => t['ansible.builtin.file']?.state === 'directory',
      )
      expect(dirTasks.length).toBeGreaterThan(0)
    })

    it('既存ディレクトリの所有者・権限は変更しない（未作成のときだけ作る）', () => {
      // `file: state=directory` は宣言的なので、無条件に実行すると既存の
      // /etc/ssl のようなディレクトリの owner/mode を書き換えてしまう。
      const dirTask = flatten(tasks()).find(
        (t) => t['ansible.builtin.file']?.state === 'directory',
      )!
      expect(dirTask.when).toBeDefined()
      expect(String(dirTask.when)).toMatch(/exists/)
    })

    it('ステージング済みのパスが存在することを確認してから配置する', () => {
      // 未ステージング時に copy が出す "Source ... not found" は、利用者から見ると
      // 原因が分からない。共有ファイル側の問題であることを名指しする。
      const stats = flatten(tasks()).filter((t) => t['ansible.builtin.stat'])
      expect(stats.length).toBeGreaterThan(0)
      const conditions = flatten(tasks())
        .filter((t) => t['ansible.builtin.assert'])
        .flatMap((t) => t['ansible.builtin.assert'].that as string[])
        .join('\n')
      expect(conditions).toMatch(/stat\.exists/)
    })
  })
})
