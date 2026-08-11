import { readFileSync } from 'fs'
import { join } from 'path'

import { DEFAULT_SCHEMA, load } from 'js-yaml'

/**
 * k3s ロールの common タスクの順序不変条件を検証する回帰テスト。
 *
 * 回帰対象のバグ: `net.bridge.bridge-nf-call-iptables` などの net.bridge.* sysctl は
 * `br_netfilter` カーネルモジュールがロードされて初めて /proc/sys/net/bridge/ に現れる。
 * 新規ホストで br_netfilter が未ロードのまま sysctl タスク（sysctl_set: true）が先に走ると
 * その項目だけ失敗し、「変更あり: はい / One or more items failed」となる（他の vm.* 等は成功）。
 *
 * したがって「カーネルモジュールを modprobe するタスクは、それに依存する sysctl タスクより
 * 前に実行されなければならない」（Kubernetes 公式の前提手順と同じ順序）。この順序不変条件を
 * 構造的に固定し、将来の編集で順序が壊れても検出できるようにする。
 *
 * 注: sysctl 適用まで実際に検証する機能テストはカーネルモジュールをロードできる特権
 * コンテナが必要で本 CI/環境では実行できないため、YAML の並び順を直接検証する。
 */
const ROLE_DIR = join(__dirname, '../../ansible/roles/k3s')

interface AnsibleTask {
  name?: string
  loop?: unknown
  'ansible.posix.sysctl'?: unknown
  'ansible.builtin.command'?: { argv?: string[] }
  [key: string]: unknown
}

function loadYaml<T>(relPath: string): T {
  const raw = readFileSync(join(ROLE_DIR, relPath), 'utf8')
  return load(raw, { schema: DEFAULT_SCHEMA }) as T
}

describe('k3s role: common.yml task ordering (br_netfilter before net.bridge sysctl)', () => {
  const tasks = loadYaml<AnsibleTask[]>('tasks/common.yml')
  const defaults = loadYaml<{
    k3s_sysctl: Record<string, string>
    k3s_kernel_modules: string[]
  }>('defaults/main.yml')

  it('前提: net.bridge.* sysctl と br_netfilter モジュールが定義されている（不変条件が意味を持つこと）', () => {
    // この2つが揃っているからこそ「モジュールを先にロードする」順序が必要になる。
    expect(Object.keys(defaults.k3s_sysctl)).toContain('net.bridge.bridge-nf-call-iptables')
    expect(defaults.k3s_kernel_modules).toContain('br_netfilter')
  })

  it('カーネルモジュールを modprobe するタスクは sysctl タスクより前に実行される', () => {
    // sysctl タスク: ansible.posix.sysctl を使うタスク。
    const sysctlIndex = tasks.findIndex(
      (t) => Object.prototype.hasOwnProperty.call(t, 'ansible.posix.sysctl'),
    )
    // モジュールロードタスク: argv に /sbin/modprobe を含む command タスク（lsmod や
    // modules-load.d への copy ではなく、実際に実行時ロードするタスク）。
    const modprobeIndex = tasks.findIndex((t) =>
      (t['ansible.builtin.command']?.argv ?? []).includes('/sbin/modprobe'),
    )

    expect(sysctlIndex).toBeGreaterThanOrEqual(0)
    expect(modprobeIndex).toBeGreaterThanOrEqual(0)
    // 根本原因: 現状は sysctl(38行目) が modprobe(66行目) より前 → br_netfilter 未ロードで
    // net.bridge.* が失敗する。modprobe を先に実行するよう順序を修正する。
    expect(modprobeIndex).toBeLessThan(sysctlIndex)
  })
})
