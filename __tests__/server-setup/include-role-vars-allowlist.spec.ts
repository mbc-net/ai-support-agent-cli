import { readFileSync, readdirSync, existsSync } from 'fs'
import * as path from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

import {
  BUNDLED_ROLE_INTERNAL_VARS,
  INCLUDE_ROLE_ALLOWED_ROLES,
  INCLUDE_ROLE_ALLOWED_VARS,
  validateAnsibleTasks,
} from '../../src/server-setup/ansible-task-guard'

/**
 * `INCLUDE_ROLE_ALLOWED_VARS`（レシピが include_role の task レベル `vars:` で
 * 渡してよい変数名のロール別 allowlist）の検証。
 *
 * **なぜこの allowlist が要るのか。** Ansible の変数優先順位では、`include_role` に付けた
 * task レベルの `vars:` は "include params" として扱われ、ロール内部の `set_fact` にも
 * `register` の結果にも勝つ。実測（ansible-core 2.17）:
 *
 *   role:   command を実行 → register: probe        （実際の出力は REAL-OUTPUT）
 *   recipe: include_role + vars: {probe: {stdout: "FAKED"}}
 *   参照時: FAKED
 *
 * したがってレシピは、ロールが計算した中間状態・ヘルスチェックの結果を丸ごと差し替えられる。
 * ロール側では防げない（呼び出し側が必ず勝つ）ため、ガードで名前を絞るのが唯一の対策になる。
 *
 * このテストの主眼は **allowlist に内部変数が混ざっていないこと**である。混ざった瞬間に
 * 防御が無効になるうえ、リストが長いので目視では気づけない。実ロールから同じ手順で
 * 再計算して突き合わせる。
 */

const rolesDir = path.join(__dirname, '..', '..', 'ansible', 'roles')

type Task = Record<string, unknown>

/** set_fact のキー・register 名・task レベル `vars:` のキー＝ロール内部で計算される名前。 */
function collectInternalNames(tasks: Task[], acc: Set<string>): void {
  for (const task of tasks) {
    if (!task || typeof task !== 'object') continue

    for (const key of ['block', 'rescue', 'always'] as const) {
      const nested = task[key]
      if (Array.isArray(nested)) collectInternalNames(nested as Task[], acc)
    }

    if (typeof task.register === 'string') acc.add(task.register)

    for (const key of ['set_fact', 'ansible.builtin.set_fact'] as const) {
      const args = task[key]
      if (args && typeof args === 'object') {
        for (const name of Object.keys(args as Record<string, unknown>)) {
          if (name !== 'cacheable') acc.add(name)
        }
      }
    }

    // include_role 以外のタスクに付いた `vars:` は、そのタスクのためにロールが
    // 計算している値。レシピが差し替えられると診断や分岐を偽装できる。
    const isInclude = 'include_role' in task || 'ansible.builtin.include_role' in task
    if (!isInclude && task.vars && typeof task.vars === 'object') {
      for (const name of Object.keys(task.vars as Record<string, unknown>)) acc.add(name)
    }
  }
}

function internalNamesOf(role: string): Set<string> {
  const acc = new Set<string>()

  const tasksDir = path.join(rolesDir, role, 'tasks')
  if (existsSync(tasksDir)) {
    for (const file of readdirSync(tasksDir)) {
      const parsed = load(readFileSync(path.join(tasksDir, file), 'utf8'))
      if (Array.isArray(parsed)) collectInternalNames(parsed as Task[], acc)
    }
  }

  // `vars/` はロールの内部派生値を置く場所であり、`defaults/` と違って
  // 「利用者が上書きする値」ではない。ここを読まなかったため、
  // ai_support_agent_k8s_item_is_self（自己 Pod 判定）や
  // *_secret_name（トークンを含む Secret 名）が allowlist へ漏れていた。
  const varsDir = path.join(rolesDir, role, 'vars')
  if (existsSync(varsDir)) {
    for (const file of readdirSync(varsDir)) {
      const parsed = load(readFileSync(path.join(varsDir, file), 'utf8'))
      if (parsed && typeof parsed === 'object') {
        for (const name of Object.keys(parsed as Record<string, unknown>)) acc.add(name)
      }
    }
  }

  return acc
}

describe('INCLUDE_ROLE_ALLOWED_VARS', () => {
  const roles = readdirSync(rolesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  it('allowlist のキーが bundled role の一覧と 1:1 で対応する', () => {
    // ロールを足して allowlist を足し忘れると、そのロールの vars が
    // 素通りになる（allowlist 未定義 = 検査しない、という実装のため）。
    expect(Object.keys(INCLUDE_ROLE_ALLOWED_VARS).sort()).toEqual(roles)
    expect([...INCLUDE_ROLE_ALLOWED_ROLES].sort()).toEqual(roles)
  })

  it.each(roles)(
    '%s: allowlist に set_fact / register / task レベル vars の名前が含まれない',
    (role) => {
      // これがこのテストの主眼。内部変数が 1 つでも混ざると、その経路は
      // レシピから差し替え可能なままになる。
      const internal = internalNamesOf(role)
      const leaked = [...INCLUDE_ROLE_ALLOWED_VARS[role]].filter((v) => internal.has(v))
      expect(leaked).toEqual([])
    },
  )

  it('破壊的な内部変数が名指しで拒否される（k3s のディスク操作）', () => {
    // k3s_ephemeral_device は by-id パスから組み立てられて parted / mkfs.ext4 へ渡る。
    // レシピから直接渡せると、ロールが安全装置としている by-id 強制を迂回して
    // 任意のブロックデバイスを破壊できる。
    for (const name of [
      'k3s_ephemeral_device',
      'k3s_ephemeral_partition',
      'k3s_ephemeral_needs_setup',
      'k3s_needs_install',
    ]) {
      expect(INCLUDE_ROLE_ALLOWED_VARS.k3s.has(name)).toBe(false)
    }
  })

  it.each(roles)('%s: allowlist に実体の無い「幽霊エントリ」が残っていない', (role) => {
    // 逆方向の検査。allowlist に載っているのにロールがどこからも参照しない名前は、
    // レシピが渡してもガードは受理し、ロールは無視する——**指定できたように見えて
    // 何も起きない**。実際に廃止した `rsyslog_forward_queue_filename` が
    // 両ガードに残り、defaults・テンプレート・web スニペット・設計書だけが
    // 更新されている状態を作ってしまった（このテストが無かったので緑のまま通った）。
    const referenced = new Set<string>()
    for (const sub of ['tasks', 'templates', 'handlers', 'defaults', 'vars']) {
      const dir = path.join(rolesDir, role, sub)
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        const text = readFileSync(path.join(dir, file), 'utf8')
        // 大文字の名前も拾う。`claude_cli` の `ANTHROPIC_API_KEY` のように、ロール接頭辞を
        // 持たない公開パラメータは実在する。小文字だけを見ていたため、この名前は
        // 「幽霊エントリ」と誤判定される一方、allowlist から漏れていても誰も気づけなかった。
        for (const m of text.matchAll(/\b([A-Za-z][A-Za-z0-9_]{2,})\b/g)) referenced.add(m[1])
      }
    }
    const ghosts = [...INCLUDE_ROLE_ALLOWED_VARS[role]].filter((v) => !referenced.has(v))
    expect(ghosts).toEqual([])
  })


  it.each(roles)('%s: ロールが読む大文字の公開パラメータが allowlist に載っている', (role) => {
    // ロール接頭辞を持たない公開パラメータは `defaults/main.yml` に既定値を置けないことが
    // 多く（テナントが `ANSIBLE#` 変数で渡す想定）、defaults 起点の検査では拾えない。
    // 漏れると、そのレシピは保存時にも実行時にも拒否される。テナント変数は大文字なので
    // （`create-config-setting.dto.ts` の `@Matches(/^[A-Z][A-Z0-9_#]{0,199}$/)`）、
    // ロールが参照する大文字の名前は公開パラメータとみなす。
    const referenced = new Set<string>()
    for (const sub of ['tasks', 'templates', 'handlers']) {
      const dir = path.join(rolesDir, role, sub)
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        const text = readFileSync(path.join(dir, file), 'utf8')
          // コメント行はドキュメント用の例を含むので除く。
          .split('\n')
          .filter((line) => !line.trim().startsWith('#'))
          .join('\n')
        // Jinja が評価する場所だけを見る（fail_msg 中のエスケープ例を拾わないため）。
        for (const rawRegion of text.match(/\{\{[^}]*\}\}/g) ?? []) {
          // `{{ '{{ MY_TOKEN }}' }}` のような二重エスケープの例は対象外。
          if (rawRegion.includes("'{{")) continue
          // 文字列リテラルの中は英文であって変数参照ではない
          // （`{{ 'API key login failed. ' if … }}` の `API` を拾わないため）。
          const region = rawRegion.replace(/'[^']*'|"[^"]*"/g, ' ')
          for (const m of region.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) referenced.add(m[1])
        }
        for (const m of text.matchAll(/^\s*(?:when|until|that):\s*(.*)$/gm)) {
          const expression = m[1].replace(/'[^']*'|"[^"]*"/g, ' ')
          for (const n of expression.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) referenced.add(n[1])
        }
      }
    }
    const missing = [...referenced].filter(
      (name) => !INCLUDE_ROLE_ALLOWED_VARS[role].has(name),
    )
    expect(missing).toEqual([])
  })

  it('公開変数（defaults のキー）は allowlist に含まれる', () => {
    // 絞りすぎて正当なレシピが壊れないことの確認。
    for (const role of roles) {
      const defaultsFile = path.join(rolesDir, role, 'defaults', 'main.yml')
      if (!existsSync(defaultsFile)) continue
      const defaults = (load(readFileSync(defaultsFile, 'utf8')) ?? {}) as Record<string, unknown>
      const missing = Object.keys(defaults).filter(
        (k) => !INCLUDE_ROLE_ALLOWED_VARS[role].has(k),
      )
      expect(missing).toEqual([])
    }
  })

  describe('validateAnsibleTasks が実際に拒否する', () => {
    const body = (role: string, vars: string): string =>
      `- name: t\n  ansible.builtin.include_role:\n    name: ${role}\n  vars:\n${vars}`

    it('内部変数を渡すレシピは拒否される（k3s のディスクデバイス）', () => {
      const result = validateAnsibleTasks(
        body('k3s', '    k3s_ephemeral_device: /dev/sda\n'),
        { mode: 'ecs' },
      )
      expect(result.ok).toBe(false)
      expect(result.violations.map((v) => v.key)).toContain('k3s_ephemeral_device')
    })

    it('ヘルスチェックの register 結果を偽装するレシピは拒否される', () => {
      const internal = [...internalNamesOf('k3s')].find((n) => n.startsWith('k3s_'))
      expect(internal).toBeDefined()
      const result = validateAnsibleTasks(body('k3s', `    ${internal}: faked\n`), {
        mode: 'ecs',
      })
      expect(result.ok).toBe(false)
    })

    it('公開変数を渡すレシピは通る', () => {
      const result = validateAnsibleTasks(
        body('k3s', "    k3s_version: v1.31.0+k3s1\n    k3s_bootstrap: init\n"),
        { mode: 'ecs' },
      )
      expect(result.ok).toBe(true)
    })

    it('tasks_from はレシピから使えない（ロール内部の検証を迂回できるため）', () => {
      // ロールは「main.yml が入力を検証し、その後で内部ファイルを include する」構成。
      // tasks_from でその内部ファイルを直接呼べると、検証を丸ごと飛ばせる。
      // zabbix_agent なら CIDR 検証を、k3s なら破壊的ディスク操作の前提チェックを迂回できた。
      for (const [role, from] of [
        ['zabbix_agent', 'ufw'],
        ['rsyslog_server', 'ufw'],
        ['k3s', 'disk'],
        ['ai_support_agent_k8s', 'project'],
        ['k3s', 'main'],
      ] as const) {
        const result = validateAnsibleTasks(
          `- name: t\n  ansible.builtin.include_role:\n    name: ${role}\n    tasks_from: ${from}\n`,
          { mode: 'ecs' },
        )
        expect(result.ok).toBe(false)
      }
    })

    it('public はレシピから使えない（内部派生値の秘匿値が後続へ露出するため）', () => {
      // public: true にすると、ロールの内部派生値（トークンを含む *_project_specs 等）が
      // 後続タスクから参照できるようになる。秘匿判定は元の変数名しか追跡しないので
      // 派生名の参照には no_log が付かず、実行ログに出る。
      const result = validateAnsibleTasks(
        '- name: t\n  ansible.builtin.include_role:\n    name: k3s\n    public: true\n',
        { mode: 'ecs' },
      )
      expect(result.ok).toBe(false)
    })

    it.each(['invalid', '[1, 2]', '42'])(
      'vars がマッピングでない場合（%s）は拒否される',
      (value) => {
        // 素通りさせるとガードは ok を返すのに、実機の ansible-playbook が
        // 「vars must be specified as a dictionary」で落ちる。保存時に弾く意味が消える。
        const result = validateAnsibleTasks(
          `- name: t\n  ansible.builtin.include_role:\n    name: docker\n  vars: ${value}\n`,
          { mode: 'ecs' },
        )
        expect(result.ok).toBe(false)
      },
    )

    it('未知のロールは vars の検査より前に role 名で拒否される（二重報告しない）', () => {
      const result = validateAnsibleTasks(body('no_such_role', '    anything: 1\n'), {
        mode: 'ecs',
      })
      expect(result.ok).toBe(false)
      expect(result.violations.filter((v) => v.key === 'anything')).toHaveLength(0)
    })
  })
})

/**
 * `BUNDLED_ROLE_INTERNAL_VARS` が実ロールと一致していることを検査する。
 *
 * このリストはガードが「レシピから読ませない・書かせない」名前の実体である。
 * ロールに新しい `set_fact` / `register` を足したのにここへ載せ忘れると、その
 * 内部変数だけレシピから読めるまま（＝秘匿値なら実行ログへ出せるまま）になる。
 * 実行時には何も起きないので、CI で赤くする以外に気づく方法がない。
 */
describe('BUNDLED_ROLE_INTERNAL_VARS と実ロールの一致', () => {
  const rolesDir = path.join(__dirname, '../../ansible/roles')

  const collectNames = (node: unknown, out: Set<string>): void => {
    if (Array.isArray(node)) {
      for (const child of node) collectNames(child, out)
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (
        (key === 'set_fact' || key === 'ansible.builtin.set_fact') &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
      ) {
        for (const name of Object.keys(value as Record<string, unknown>)) {
          if (name !== 'cacheable') out.add(name)
        }
      }
      if (key === 'register' && typeof value === 'string') out.add(value)
      // include_role 以外のタスクに付いた `vars:` のキーも、ロールが自分で計算する値である。
      // `set_fact` は task レベル `vars:` より優先度が高いので、レシピから上書きできる
      // （`rsyslog_server_reserved_log_dirs` を空にされれば denylist ごと無効化される）。
      if (
        key === 'vars' &&
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !('include_role' in (node as Record<string, unknown>)) &&
        !('ansible.builtin.include_role' in (node as Record<string, unknown>))
      ) {
        for (const name of Object.keys(value as Record<string, unknown>)) out.add(name)
      }
      if (value !== null && typeof value === 'object') collectNames(value, out)
    }
  }

  const harvest = (): Set<string> => {
    const found = new Set<string>()
    for (const role of readdirSync(rolesDir)) {
      for (const sub of ['tasks', 'handlers']) {
        const dir = path.join(rolesDir, role, sub)
        if (!existsSync(dir)) continue
        for (const file of readdirSync(dir)) {
          if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue
          const doc = load(readFileSync(path.join(dir, file), 'utf8'), {
            schema: DEFAULT_SCHEMA,
          })
          collectNames(doc, found)
        }
      }
    }
    // `vars/main.yml` の派生値。ロール内部の計算結果であり、`set_fact` は
    // role vars（優先度 15）より上（19）なのでレシピから上書きできてしまう。
    // 例: `github_runner_k8s_secret_name` は shell へ展開される前にロールが書式検証している。
    for (const role of readdirSync(rolesDir)) {
      const varsFile = path.join(rolesDir, role, 'vars', 'main.yml')
      if (!existsSync(varsFile)) continue
      const doc = load(readFileSync(varsFile, 'utf8'), { schema: DEFAULT_SCHEMA })
      if (doc !== null && typeof doc === 'object' && !Array.isArray(doc)) {
        for (const name of Object.keys(doc as Record<string, unknown>)) found.add(name)
      }
    }
    return found
  }

  it('ロールが内部で使う名前（set_fact / register / タスクの vars / vars/main.yml）をすべて含む', () => {
    const missing = [...harvest()]
      .filter((name) => !BUNDLED_ROLE_INTERNAL_VARS.has(name))
      .sort()
    expect(missing).toEqual([])
  })

  it('実在しない名前を含まない（削除された内部変数の残骸が無い）', () => {
    const actual = harvest()
    const ghosts = [...BUNDLED_ROLE_INTERNAL_VARS]
      .filter((name) => !actual.has(name))
      .sort()
    expect(ghosts).toEqual([])
  })
})
