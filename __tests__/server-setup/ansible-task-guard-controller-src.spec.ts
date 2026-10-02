import {
  AnsibleTaskViolation,
  validateAnsibleTasks,
} from '../../src/server-setup/ansible-task-guard'

/**
 * コントローラ（常駐 agent ホスト／当社 ECS）上のファイルをレシピ経由で対象ホストへ
 * 持ち出す経路の検証。
 *
 * 仕様:
 * - (a) モジュール引数の文字列形式（`module: k=v ...`）は command / shell（FQCN・短縮形）
 *   だけ許可し、それ以外の許可モジュールでは拒否する。
 * - (b) unarchive / uri の `src` は、同じタスクのモジュール引数に `remote_src: true`
 *   （YAML の真偽値 true そのもの）があるときだけ許可する。
 * - (c) copy の `src` は常に拒否する。
 *
 * 拒否理由の文字列は実装で決まるため固定せず、`ok === false` と、違反が対象タスク
 * （taskIndex）と対象キー（`src` またはモジュールキー）に付いていることを検証する。
 * 対象タスクは先頭に無害なタスクを 1 つ置いて index 1 にし、taskIndex の検査を有効にする。
 */
describe('コントローラ側ファイルの持ち出し経路（文字列形式・unarchive/uri の src）', () => {
  const ecs = { mode: 'ecs' as const }
  const resident = { mode: 'resident' as const }
  type Opts = typeof ecs | typeof resident

  /** 対象タスクの前に置く無害なタスク（対象を taskIndex 1 にするため）。 */
  const PRELUDE = `- name: prelude
  ansible.builtin.debug:
    msg: "start"
`
  const TARGET_INDEX = 1

  const withPrelude = (task: string): string => `${PRELUDE}${task}`

  const hasViolationOn = (
    violations: AnsibleTaskViolation[],
    allowedKeys: readonly string[],
  ): boolean =>
    violations.some(
      (v) => v.taskIndex === TARGET_INDEX && allowedKeys.includes(v.key),
    )

  const expectRejected = (
    body: string,
    opts: Opts,
    allowedKeys: readonly string[],
  ): void => {
    const result = validateAnsibleTasks(body, opts)
    expect(result.ok).toBe(false)
    expect(hasViolationOn(result.violations, allowedKeys)).toBe(true)
  }

  const expectAccepted = (body: string, opts: Opts): void => {
    const result = validateAnsibleTasks(body, opts)
    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  }

  describe('(c) copy の src は文字列形式でも拒否される', () => {
    const cases: Array<[string, string, Opts]> = [
      ['FQCN・ecs', 'ansible.builtin.copy', ecs],
      ['FQCN・resident', 'ansible.builtin.copy', resident],
      ['短縮形・ecs', 'copy', ecs],
      ['短縮形・resident', 'copy', resident],
    ]
    it.each(cases)('copy: src=... dest=...（%s）は拒否される', (_label, moduleKey, opts) => {
      const body = withPrelude(`- name: copy via kv
  ${moduleKey}: src=/tmp/controller-only/file dest=/tmp/x
`)
      expectRejected(body, opts, ['src', moduleKey])
    })
  })

  describe('(a) command / shell 以外の文字列形式は拒否される', () => {
    const tasks: Array<[string, string]> = [
      ['ansible.builtin.apt', 'name=curl state=present'],
      ['apt', 'name=curl state=present'],
      ['ansible.builtin.file', 'path=/tmp/x state=directory'],
      ['file', 'path=/tmp/x state=directory'],
      ['ansible.builtin.lineinfile', 'path=/tmp/x line=hello'],
      ['lineinfile', 'path=/tmp/x line=hello'],
      ['ansible.builtin.service', 'name=nginx state=started'],
      ['ansible.builtin.get_url', 'url=https://example.com/a dest=/tmp/x'],
    ]
    const cases: Array<[string, string, string, Opts]> = tasks.flatMap(
      ([moduleKey, args]): Array<[string, string, string, Opts]> => [
        [moduleKey, 'ecs', args, ecs],
        [moduleKey, 'resident', args, resident],
      ],
    )
    it.each(cases)('%s の文字列形式（%s）は拒否される', (moduleKey, _mode, args, opts) => {
      const body = withPrelude(`- name: free-form args
  ${moduleKey}: ${args}
`)
      expectRejected(body, opts, [moduleKey])
    })
  })

  describe('(b) unarchive の src は remote_src: true（真偽値）のときだけ許可される', () => {
    describe('resident で拒否されるケース', () => {
      const mappingCases: Array<[string, string]> = [
        ['src のみ（remote_src なし）', ''],
        ['remote_src: false', '\n    remote_src: false'],
        ['remote_src: "true"（文字列）', '\n    remote_src: "true"'],
        ['remote_src: yes', '\n    remote_src: yes'],
        ['remote_src: "{{ v }}"（Jinja 式）', '\n    remote_src: "{{ v }}"'],
      ]
      it.each(mappingCases)('FQCN マッピング形式: %s は拒否される', (_label, extra) => {
        const body = withPrelude(`- name: unarchive
  ansible.builtin.unarchive:
    src: /tmp/controller-only/file.tar.gz
    dest: /tmp/x${extra}
`)
        expectRejected(body, resident, ['src'])
      })

      it('短縮形マッピング形式: src のみ（remote_src なし）は拒否される', () => {
        const body = withPrelude(`- name: unarchive short
  unarchive:
    src: /tmp/controller-only/file.tar.gz
    dest: /tmp/x
`)
        expectRejected(body, resident, ['src'])
      })

      it.each([['ansible.builtin.unarchive'], ['unarchive']])(
        '%s の文字列形式は拒否される',
        (moduleKey) => {
          const body = withPrelude(`- name: unarchive via kv
  ${moduleKey}: src=/tmp/controller-only/file.tar.gz dest=/tmp/x
`)
          expectRejected(body, resident, ['src', moduleKey])
        },
      )

      it('文字列形式で remote_src=true を書いても拒否される', () => {
        const body = withPrelude(`- name: unarchive via kv remote
  ansible.builtin.unarchive: src=/tmp/x.tar.gz dest=/tmp/x remote_src=true
`)
        expectRejected(body, resident, ['src', 'ansible.builtin.unarchive'])
      })
    })

    it('ecs ではそもそも拒否される（理由は問わない）', () => {
      const body = withPrelude(`- name: unarchive
  ansible.builtin.unarchive:
    src: /tmp/x.tar.gz
    dest: /tmp/x
    remote_src: true
`)
      expect(validateAnsibleTasks(body, ecs).ok).toBe(false)
    })

    it.each([['ansible.builtin.unarchive'], ['unarchive']])(
      'resident: %s の src + remote_src: true（YAML 真偽値）は許可される',
      (moduleKey) => {
        const body = withPrelude(`- name: unarchive remote
  ${moduleKey}:
    src: /tmp/x.tar.gz
    dest: /tmp/x
    remote_src: true
`)
        expectAccepted(body, resident)
      },
    )
  })

  describe('(b) uri の src は remote_src: true（真偽値）のときだけ許可される', () => {
    it.each([['ansible.builtin.uri'], ['uri']])(
      'resident: %s のマッピング形式で src あり（remote_src なし）は拒否される',
      (moduleKey) => {
        const body = withPrelude(`- name: uri post file
  ${moduleKey}:
    url: https://example.com/upload
    method: POST
    src: /tmp/controller-only/file
`)
        expectRejected(body, resident, ['src'])
      },
    )

    it.each([
      ['remote_src: false', 'false'],
      ['remote_src: "true"（文字列）', '"true"'],
      ['remote_src: "{{ v }}"（Jinja 式）', '"{{ v }}"'],
    ])('resident: uri の src + %s は拒否される', (_label, value) => {
      const body = withPrelude(`- name: uri post file
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    src: /tmp/controller-only/file
    remote_src: ${value}
`)
      expectRejected(body, resident, ['src'])
    })

    it.each([['ansible.builtin.uri'], ['uri']])(
      'resident: %s の文字列形式は拒否される',
      (moduleKey) => {
        const body = withPrelude(`- name: uri via kv
  ${moduleKey}: url=https://example.com/upload method=POST src=/tmp/controller-only/file
`)
        expectRejected(body, resident, ['src', moduleKey])
      },
    )

    it('ecs ではそもそも拒否される（理由は問わない）', () => {
      const body = withPrelude(`- name: uri
  ansible.builtin.uri:
    url: https://example.com/health
    method: GET
`)
      expect(validateAnsibleTasks(body, ecs).ok).toBe(false)
    })

    it.each([['ansible.builtin.uri'], ['uri']])(
      'resident: %s の src 無し（url + method のみ）は許可される',
      (moduleKey) => {
        const body = withPrelude(`- name: uri health
  ${moduleKey}:
    url: https://example.com/health
    method: GET
`)
        expectAccepted(body, resident)
      },
    )

    it('resident: uri の src + remote_src: true（YAML 真偽値）は許可される', () => {
      const body = withPrelude(`- name: uri post remote file
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    src: /tmp/x
    remote_src: true
`)
      expectAccepted(body, resident)
    })
  })

  describe('回帰防止: 修正後も通るべきもの（現行でも緑）', () => {
    const modes: Array<[string, Opts]> = [
      ['ecs', ecs],
      ['resident', resident],
    ]

    describe.each(modes)('%s', (_mode, opts) => {
      it.each([
        ['ansible.builtin.command', 'cat /tmp/x'],
        ['command', 'cat /tmp/x'],
        ['ansible.builtin.shell', 'echo hello > /tmp/x'],
        ['shell', 'echo hello > /tmp/x'],
      ])('%s の文字列形式は許可される', (moduleKey, args) => {
        const body = withPrelude(`- name: free-form command
  ${moduleKey}: ${args}
`)
        expectAccepted(body, opts)
      })

      it.each([['ansible.builtin.copy'], ['copy']])(
        '%s の content + dest（マッピング形式）は許可される',
        (moduleKey) => {
          const body = withPrelude(`- name: write file
  ${moduleKey}:
    content: "hello"
    dest: /tmp/x
`)
          expectAccepted(body, opts)
        },
      )

      it('apt / file / lineinfile のマッピング形式は許可される', () => {
        const body = withPrelude(`- name: install
  ansible.builtin.apt:
    name: curl
    state: present
- name: dir
  file:
    path: /tmp/x
    state: directory
- name: line
  ansible.builtin.lineinfile:
    path: /tmp/x/conf
    line: hello
`)
        expectAccepted(body, opts)
      })
    })
  })

  /**
   * ansible-core 2.17 の uri action plugin は `remote_src` が真でないとき、`src` が
   * 無くても `body_format == 'form-multipart'` なら `body` の各フィールドの `filename` を
   * コントローラ側のパスとして読み、対象ホストへ転送する。モジュール引数の値は実行前に
   * テンプレート展開されるので、`body_format` が Jinja 式なら実行時に form-multipart に
   * なり得る。
   *
   * 仕様: uri は `body_format` が「Jinja を含まない、form-multipart 以外の文字列」でない限り
   * （＝ form-multipart そのもの・Jinja を含む・文字列以外）`remote_src: true` を必須にする。
   */
  describe('(d) uri の form-multipart は remote_src: true（真偽値）のときだけ許可される', () => {
    const bodyFormatKeys = ['body_format', 'ansible.builtin.uri', 'uri']

    it.each([['ansible.builtin.uri'], ['uri']])(
      'resident: %s の form-multipart + body.filename（remote_src なし）は拒否される',
      (moduleKey) => {
        const body = withPrelude(`- name: uri multipart
  ${moduleKey}:
    url: https://example.com/upload
    method: POST
    body_format: form-multipart
    body:
      file1:
        filename: /tmp/controller-only/file
`)
        expectRejected(body, resident, bodyFormatKeys)
      },
    )

    it('resident: body_format が Jinja 式（"{{ fmt }}"）なら拒否される', () => {
      const body = withPrelude(`- name: uri templated format
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    body_format: "{{ fmt }}"
    body:
      file1:
        filename: /tmp/controller-only/file
`)
      expectRejected(body, resident, bodyFormatKeys)
    })

    it('resident: body_format が {% %} を含む文字列なら拒否される', () => {
      const body = withPrelude(`- name: uri templated format block
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    body_format: "{% if true %}form-multipart{% endif %}"
    body: "{{ payload }}"
`)
      expectRejected(body, resident, bodyFormatKeys)
    })

    it('resident: body がテンプレート文字列の form-multipart は拒否される', () => {
      const body = withPrelude(`- name: uri multipart templated body
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    body_format: form-multipart
    body: "{{ payload }}"
`)
      expectRejected(body, resident, bodyFormatKeys)
    })

    it('resident: body_format が文字列以外なら拒否される', () => {
      const body = withPrelude(`- name: uri non-string format
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    body_format: ["form-multipart"]
`)
      expectRejected(body, resident, bodyFormatKeys)
    })

    it.each([
      ['remote_src: false', 'false'],
      ['remote_src: "true"（文字列）', '"true"'],
      ['remote_src: yes', 'yes'],
      ['remote_src: "{{ v }}"（Jinja 式）', '"{{ v }}"'],
    ])('resident: form-multipart + %s は拒否される', (_label, value) => {
      const body = withPrelude(`- name: uri multipart
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    body_format: form-multipart
    body:
      file1:
        filename: /tmp/controller-only/file
    remote_src: ${value}
`)
      expectRejected(body, resident, bodyFormatKeys)
    })

    it.each([['ansible.builtin.uri'], ['uri']])(
      'resident: %s の form-multipart + remote_src: true（YAML 真偽値）は許可される',
      (moduleKey) => {
        const body = withPrelude(`- name: uri multipart remote
  ${moduleKey}:
    url: https://example.com/upload
    method: POST
    body_format: form-multipart
    body:
      file1:
        filename: /tmp/x
    remote_src: true
`)
        expectAccepted(body, resident)
      },
    )

    it('resident: body_format が {# #}（Jinja コメント）を含む文字列なら拒否される', () => {
      // Templar は `form-{# c #}multipart` を `form-multipart` に展開する（ansible-core 2.17 実測）。
      const body = withPrelude(`- name: uri commented format
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    body_format: "form-{# c #}multipart"
    body:
      file1:
        filename: /tmp/controller-only/file
`)
      expectRejected(body, resident, bodyFormatKeys)
    })

    it.each([
      ['値なし（body_format:）', 'body_format:'],
      ['null（body_format: null）', 'body_format: null'],
    ])('resident: body_format が %s なら form-multipart 経路ではないので許可される', (_label, line) => {
      // uri action plugin は `self._task.args.get('body_format', 'raw')` で取り、
      // `== 'form-multipart'` と比べる。null（None）は form-multipart ではない。
      const body = withPrelude(`- name: uri null format
  ansible.builtin.uri:
    url: https://example.com/api
    method: POST
    ${line}
    body:
      name: hello
`)
      expectAccepted(body, resident)
    })

    it.each([
      ['数値', '1'],
      ['マッピング', '{ kind: form-multipart }'],
    ])('resident: body_format が文字列以外（%s）なら拒否される', (_label, value) => {
      const body = withPrelude(`- name: uri non-string format
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    body_format: ${value}
    body:
      file1:
        filename: /tmp/controller-only/file
`)
      expectRejected(body, resident, bodyFormatKeys)
    })

    it('resident: body_format が {# #} を含んでも remote_src: true（真偽値）なら許可される', () => {
      const body = withPrelude(`- name: uri commented format remote
  ansible.builtin.uri:
    url: https://example.com/upload
    method: POST
    body_format: "form-{# c #}multipart"
    body:
      file1:
        filename: /tmp/x
    remote_src: true
`)
      expectAccepted(body, resident)
    })

    it.each([
      ['大文字混じり（Form-Multipart）', 'Form-Multipart'],
      ['前後に空白', '" form-multipart "'],
    ])(
      'resident: body_format が %s なら form-multipart 経路ではないので拒否しない',
      (_label, format) => {
        // uri action plugin の判定は `body_format == 'form-multipart'` の完全一致なので、
        // これらはコントローラのファイルを読む経路に入らない（過剰拒否しないことの確認）。
        const body = withPrelude(`- name: uri non-multipart
  ansible.builtin.uri:
    url: https://example.com/api
    method: POST
    body_format: ${format}
    body:
      name: hello
`)
        expectAccepted(body, resident)
      },
    )

    it.each([
      ['json', 'json'],
      ['form-urlencoded', 'form-urlencoded'],
      ['raw', 'raw'],
    ])('resident: body_format: %s + body は許可される', (_label, format) => {
      const body = withPrelude(`- name: uri post
  ansible.builtin.uri:
    url: https://example.com/api
    method: POST
    body_format: ${format}
    body:
      name: hello
`)
      expectAccepted(body, resident)
    })
  })

  /**
   * 多層防御: モジュール引数のキーに Jinja（`{{` / `{%` / `{#`）を含むものは、すべての
   * 許可モジュールで拒否する。キーがテンプレート展開されるかはモジュール・版によって異なり得る
   * （ansible-core 2.17.14 では copy / unarchive / uri のキーは展開されなかったが、debug のキーに
   * 置いた lookup は実行された。いずれも実測）ので、両方を想定して防ぐ。キーを Jinja で書く
   * 正当な用途は無い。
   * ecs で allowlist 外のモジュール（unarchive / uri）は理由を問わず拒否でよい。
   */
  describe('(e) モジュール引数のキーに Jinja を含むものは拒否される', () => {
    const templatedKeys: Array<[string]> = [
      [`"{{ 'src' }}"`],
      [`"s{{ 'rc' }}"`],
      [`"{% if true %}src{% endif %}"`],
      // Jinja のコメント区切り `{# #}` も実行時に除去されて `src` になる
      // （Ansible の is_possibly_template は `{{` / `{%` / `{#` の 3 種類を見る）。
      [`"s{# x #}rc"`],
      [`"{# x #}src"`],
    ]
    const modules: Array<[string, string]> = [
      ['ansible.builtin.copy', 'dest: /tmp/x'],
      ['copy', 'dest: /tmp/x'],
      ['ansible.builtin.unarchive', 'dest: /tmp/x'],
      ['ansible.builtin.uri', 'url: https://example.com/upload'],
      ['ansible.builtin.file', 'path: /tmp/x'],
      ['file', 'path: /tmp/x'],
    ]
    const cases: Array<[string, string, string, string, Opts]> = modules.flatMap(
      ([moduleKey, other]) =>
        templatedKeys.flatMap(([templatedKey]): Array<[string, string, string, string, Opts]> => [
          [moduleKey, templatedKey, 'ecs', other, ecs],
          [moduleKey, templatedKey, 'resident', other, resident],
        ]),
    )

    it.each(cases)(
      '%s のキー %s（%s）は拒否される',
      (moduleKey, templatedKey, mode, other, opts) => {
        const body = withPrelude(`- name: templated key
  ${moduleKey}:
    ${templatedKey}: /tmp/controller-only/file
    ${other}
`)
        const result = validateAnsibleTasks(body, opts)
        expect(result.ok).toBe(false)
        if (mode === 'resident' || !/unarchive|uri/.test(moduleKey)) {
          // allowlist 内のモジュールでは、テンプレート化したキーそのものに違反が付く。
          const parsedKey = templatedKey.slice(1, -1)
          expect(hasViolationOn(result.violations, [parsedKey])).toBe(true)
        }
      },
    )

    it('Jinja を含まないキーは影響を受けない（file のマッピング形式は許可される）', () => {
      const body = withPrelude(`- name: plain keys
  ansible.builtin.file:
    path: /tmp/x
    state: directory
    mode: "0755"
`)
      expectAccepted(body, resident)
      expectAccepted(body, ecs)
    })
  })

  /**
   * Ansible の内部引数（`_raw_params` / `_variable_params` / `_ansible_*` など、`_` で始まるキー）を
   * モジュール引数のマッピングに直接書くことは拒否する。
   *
   * ansible-core 2.17 の `parsing/mod_args.py` は、raw-param モジュール以外で `_raw_params` が
   * テンプレートなら `_variable_params` に移し、`playbook/task.py` の `_post_validate_args` が
   * それを辞書に展開して引数へマージする。`copy: { dest: ..., _raw_params: "{{ {'src': ...} }}" }`
   * は実行時にコントローラ側の src を持つ copy になる（2.17.14 で実測）。マッピング前提の静的な
   * 検査（copy の src・unarchive/uri の remote_src・debug.var の走査）がすべて素通りする。
   * 例外は command / shell の `_raw_params`（コマンド文字列としての本来の用途）だけ。
   */
  describe('(g) モジュール引数の内部キー（_ で始まるキー）は拒否される', () => {
    const smuggled = `"{{ {'src': '/tmp/controller-only/file'} }}"`
    const internalKeys = ['_raw_params', '_variable_params', '_ansible_x']
    const modules: Array<[string, string]> = [
      ['ansible.builtin.copy', 'dest: /tmp/x'],
      ['copy', 'dest: /tmp/x'],
      ['ansible.builtin.unarchive', 'dest: /tmp/x'],
      ['ansible.builtin.uri', 'url: https://example.com/upload'],
      ['ansible.builtin.file', 'path: /tmp/x'],
      ['ansible.builtin.debug', 'msg: hi'],
      ['ansible.builtin.apt', 'name: curl'],
    ]
    const cases: Array<[string, string, string, string, Opts]> = modules.flatMap(
      ([moduleKey, other]) =>
        internalKeys.flatMap((internalKey): Array<[string, string, string, string, Opts]> => [
          [moduleKey, internalKey, 'ecs', other, ecs],
          [moduleKey, internalKey, 'resident', other, resident],
        ]),
    )

    it.each(cases)('%s の %s（%s）は拒否される', (moduleKey, internalKey, mode, other, opts) => {
      const body = withPrelude(`- name: internal arg
  ${moduleKey}:
    ${other}
    ${internalKey}: ${smuggled}
`)
      const result = validateAnsibleTasks(body, opts)
      expect(result.ok).toBe(false)
      if (mode === 'resident' || !/unarchive|uri/.test(moduleKey)) {
        expect(hasViolationOn(result.violations, [internalKey])).toBe(true)
      }
    })

    it.each([
      ['_variable_params', `"{{ {'ansible_connection': 'local'} }}"`],
      ['_raw_params', `"{{ {'ansible_connection': 'local'} }}"`],
      ['_ansible_x', '1'],
    ])('set_fact の %s も拒否される（予約名の検査をすり抜けて任意の名前を書けるため）', (internalKey, value) => {
      const body = withPrelude(`- name: set_fact internal arg
  ansible.builtin.set_fact:
    ${internalKey}: ${value}
`)
      for (const opts of [ecs, resident]) {
        const result = validateAnsibleTasks(body, opts)
        expect(result.ok).toBe(false)
        expect(hasViolationOn(result.violations, [internalKey])).toBe(true)
      }
    })

    it.each([['ansible.builtin.command'], ['ansible.builtin.shell'], ['command'], ['shell']])(
      '%s の _raw_params（本来の用途）は許可される',
      (moduleKey) => {
        const body = withPrelude(`- name: raw params command
  ${moduleKey}:
    _raw_params: echo hello
    chdir: /tmp
`)
        expectAccepted(body, ecs)
        expectAccepted(body, resident)
      },
    )

    it('command の _raw_params 以外の内部キー（_uses_shell）は拒否される', () => {
      const body = withPrelude(`- name: uses shell
  ansible.builtin.command:
    _raw_params: echo hello
    _uses_shell: true
`)
      const result = validateAnsibleTasks(body, resident)
      expect(result.ok).toBe(false)
      expect(hasViolationOn(result.violations, ['_uses_shell'])).toBe(true)
    })
  })

  /**
   * 未閉じの Jinja コメント `{#` は検証できないので拒否する（仕様として固定）。
   * シェルの `${#var}` は Ansible でも "Missing end of comment tag" で失敗する。
   * 書きたい場合は `{{ '{' }}#` を使う（ansible-core 2.17.14 で文字列形式・マッピング形式とも
   * `${#arr[@]}` として実行されることを確認）。`{{ '{#' }}` はマッピング形式（`cmd:`）では
   * 動くが、文字列形式では Ansible の引数分割（split_args）が `{#` を開きブロックと数えて
   * "unbalanced jinja2 block" で失敗するので、案内には使わない。
   */
  describe('(h) Jinja コメントとシェルの ${#var}', () => {
    it('閉じたコメント {# note #} を含む command は許可される', () => {
      const body = withPrelude(`- name: closed comment
  ansible.builtin.command: "echo hello {# note #}"
`)
      expectAccepted(body, ecs)
      expectAccepted(body, resident)
    })

    it("${{ '{#' }}arr[@]} を含む shell（マッピング形式の cmd）は許可される", () => {
      const body = withPrelude(`- name: array length via escaped comment start
  ansible.builtin.shell:
    cmd: "arr=(a b); echo \${{ '{#' }}arr[@]}"
`)
      expectAccepted(body, ecs)
      expectAccepted(body, resident)
    })

    it("${{ '{' }}#arr[@]} を含む shell（文字列形式）は許可される", () => {
      const body = withPrelude(`- name: array length via escaped brace
  ansible.builtin.shell: "arr=(a b); echo \${{ '{' }}#arr[@]}"
`)
      expectAccepted(body, ecs)
      expectAccepted(body, resident)
    })

    it("${#arr[@]} を含む shell は拒否され、理由が {{ '{' }}# の書き方を案内する", () => {
      const body = withPrelude(`- name: array length
  ansible.builtin.shell: "arr=(a b); echo \${#arr[@]}"
`)
      const result = validateAnsibleTasks(body, resident)
      expect(result.ok).toBe(false)
      expect(
        result.violations.some(
          (v) =>
            v.taskIndex === TARGET_INDEX &&
            v.reason.includes('{#') &&
            v.reason.includes("{{ '{' }}#"),
        ),
      ).toBe(true)
    })
  })

  describe('(f) remote_src 違反の理由は真偽値 true での指定を求める', () => {
    const cases: Array<[string, string]> = [
      [
        'unarchive の src',
        `- name: unarchive
  ansible.builtin.unarchive:
    src: /tmp/controller-only/file.tar.gz
    dest: /tmp/x
    remote_src: yes
`,
      ],
      [
        'uri の src',
        `- name: uri
  ansible.builtin.uri:
    url: https://example.com/upload
    src: /tmp/controller-only/file
    remote_src: "true"
`,
      ],
      [
        'uri の form-multipart',
        `- name: uri multipart
  ansible.builtin.uri:
    url: https://example.com/upload
    body_format: form-multipart
    body:
      file1:
        filename: /tmp/controller-only/file
`,
      ],
    ]
    it.each(cases)('%s の理由に remote_src・true・yes・"true" が含まれる', (_label, task) => {
      const result = validateAnsibleTasks(withPrelude(task), resident)
      const target = result.violations.filter((v) => v.taskIndex === TARGET_INDEX)
      expect(target).toHaveLength(1)
      const reason = target[0].reason
      expect(reason).toContain('remote_src')
      expect(reason).toContain('true')
      expect(reason).toContain('yes')
      expect(reason).toContain('"true"')
    })

    it('uri の form-multipart の理由は form-multipart に言及する', () => {
      const result = validateAnsibleTasks(
        withPrelude(`- name: uri multipart
  ansible.builtin.uri:
    url: https://example.com/upload
    body_format: form-multipart
    body:
      file1:
        filename: /tmp/controller-only/file
`),
        resident,
      )
      const target = result.violations.filter((v) => v.taskIndex === TARGET_INDEX)
      expect(target.map((v) => v.reason).join('\n')).toContain('form-multipart')
    })
  })
})
