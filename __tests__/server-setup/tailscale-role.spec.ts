import { readFileSync } from 'fs'
import * as path from 'path'

import { load } from 'js-yaml'

/**
 * tailscale bundled role（agent/ansible/roles/tailscale）の静的検証。
 *
 * role 内部のタスクは信頼済み同梱コードのため `validateAnsibleTasks`（body ガード）
 * の対象外だが、YAML として壊れていると実機の `ansible-playbook` が起動時に失敗する。
 * ここでは (1) defaults/main.yml がパースでき主要トグルの既定値（機能フラグは既定オフ・
 * 秘匿値/ホスト名はハードコードせず空）を持つこと、(2) tasks/main.yml がタスク列として
 * パースできること、(3) 秘匿 auth key を argv に載せず 0600 一時ファイル＋
 * `--auth-key=file:` 経由で扱う（no_log 付き）ことを raw テキストで検証する。
 * 実際の tailnet 参加挙動は jest では検証不可で、`ansible-playbook --syntax-check`
 * （ansible 利用可能時）と指示書の受け入れ条件（実機）に委ねる。
 */
describe('tailscale bundled role', () => {
  const roleDir = path.join(__dirname, '..', '..', 'ansible', 'roles', 'tailscale')

  function readRaw(...segments: string[]): string {
    return readFileSync(path.join(roleDir, ...segments), 'utf8')
  }

  function loadYaml(...segments: string[]): unknown {
    return load(readRaw(...segments))
  }

  it('defaults/main.yml が機能トグルの既定値（ssh/exit_node/accept_routes は既定オフ）を持つ', () => {
    const defaults = loadYaml('defaults', 'main.yml') as Record<string, unknown>
    expect(defaults).toBeTruthy()
    // 機能フラグは既定オプトイン（false）
    expect(defaults.tailscale_ssh).toBe(false)
    expect(defaults.tailscale_advertise_exit_node).toBe(false)
    expect(defaults.tailscale_accept_routes).toBe(false)
  })

  it('defaults/main.yml は秘匿値・ホスト名をハードコードせず空にしている', () => {
    const defaults = loadYaml('defaults', 'main.yml') as Record<string, unknown>
    // auth key（秘匿）は呼び出し側で ANSIBLE# 変数として供給する → 既定は空
    expect(defaults.tailscale_authkey ?? '').toBe('')
    // hostname は既定 OS ホスト名（未指定）→ 既定は空
    expect(defaults.tailscale_hostname ?? '').toBe('')
  })

  it('defaults/main.yml のインストーラ URL は公式ホストにピン留めされている', () => {
    const defaults = loadYaml('defaults', 'main.yml') as Record<string, unknown>
    expect(defaults.tailscale_install_url).toBe('https://tailscale.com/install.sh')
  })

  it('tasks/main.yml がタスク列（配列）としてパースできる', () => {
    const tasks = loadYaml('tasks', 'main.yml')
    expect(Array.isArray(tasks)).toBe(true)
    expect((tasks as unknown[]).length).toBeGreaterThan(0)
  })

  it('tasks/main.yml は秘匿値保護（no_log）を含む', () => {
    const tasksText = readRaw('tasks', 'main.yml')
    expect(tasksText).toContain('no_log')
  })

  it('tasks/main.yml は auth key を file: スキーム経由で扱い、公式インストーラ URL を含む', () => {
    const tasksText = readRaw('tasks', 'main.yml')
    expect(tasksText).toContain('--auth-key=file:')
    expect(tasksText).toContain('https://tailscale.com/install.sh')
  })

  it('auth key は shell body へ Jinja 展開されず TS_KEYFILE 環境変数＋一時ファイル経由でのみ渡る', () => {
    const tasksText = readRaw('tasks', 'main.yml')
    // 一時ファイルパスは環境変数 TS_KEYFILE 経由でシェルへ渡す
    expect(tasksText).toContain('TS_KEYFILE')
    // 秘匿 auth key を `--auth-key="file:{{ ... }}"` の形で shell 本文へ直接展開しない
    expect(tasksText).not.toContain('--auth-key="file:{{')
  })

  it('失敗診断は stderr を出しつつ auth key パターンをマスクする', () => {
    const tasksText = readRaw('tasks', 'main.yml')
    // stderr を診断に載せるが auth key（tskey-...）は regex_replace でマスクする
    expect(tasksText).toContain('tskey-[A-Za-z0-9-]+')
  })

  it('成功時に advertised routes / exit node の admin console 承認が必要な旨を通知する', () => {
    const tasksText = readRaw('tasks', 'main.yml')
    expect(tasksText).toMatch(/admin console/i)
    expect(tasksText).toContain('advertise')
  })
})
