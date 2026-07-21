/**
 * Static analysis tests for the bundled tmux status-bar config.
 *
 * Reads the actual committed docker/tmux.conf (no fs mocking) to verify the
 * status bar renders session identity instead of the container hostname,
 * which is a random, meaningless container ID rather than a useful label.
 */

import * as fs from 'fs'
import * as path from 'path'

const TMUX_CONF = path.resolve(__dirname, '../../docker/tmux.conf')
const DOCKERFILE = path.resolve(__dirname, '../../docker/Dockerfile')

describe('docker/tmux.conf content validation', () => {
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(TMUX_CONF, 'utf-8')
  })

  it('enables the status bar at the bottom', () => {
    expect(content).toMatch(/set -g status on\b/)
    expect(content).toMatch(/set -g status-position bottom\b/)
  })

  it('shows the tmux session name (#S) on the status-left segment', () => {
    expect(content).toMatch(/status-left\s+'[^']*#S/)
  })

  it('does NOT use #h (container hostname is a meaningless random ID, not the tmux session)', () => {
    expect(content).not.toMatch(/#h\b/)
  })

  it('shows the current date and time on the status-right segment', () => {
    expect(content).toMatch(/status-right\s+'[^']*%Y-%m-%d[^']*%H:%M/)
  })

  it('highlights the active window differently from inactive windows', () => {
    expect(content).toMatch(/window-status-current-format\s+'/)
    expect(content).toMatch(/window-status-format\s+'/)
  })

  // 回帰テスト: status-right の #{?cond,...} 条件式内で #[fg=X\,bg=Y\,bold] の
  // ようにバックスラッシュでカンマをエスケープする書き方は、Debianパッケージの
  // tmux 3.3a（このDockerイメージが実際にインストールするバージョン）では
  // 正しくパースできず、生の設定文字列がそのままステータスバーに表示される
  // （実機のDockerイメージ上のtmux 3.3aで再現・検証済み。手元のtmux 3.6bでは
  // 問題なく動くため気づきにくい）。#[...] のスタイル属性はスペース区切り
  // （#[fg=X bg=Y bold]）にすれば同じtmux 3.3aで正しく描画されることを確認済み。
  it('does NOT use backslash-escaped commas inside #[...] style tags (breaks tmux 3.3a parsing)', () => {
    const brokenPattern = /#\[[^\]]*\\,/
    expect(content).not.toMatch(brokenPattern)
  })

  it('enables mouse support for scroll and selection', () => {
    expect(content).toMatch(/^set -g mouse on\b/m)
  })

  it('sets copy-mode to vi key bindings', () => {
    expect(content).toMatch(/^setw -g mode-keys vi\b/m)
  })

  it('binds v/V/C-v in copy-mode-vi for selection (begin/line/rectangle-toggle)', () => {
    expect(content).toMatch(/bind -T copy-mode-vi v send -X begin-selection\b/)
    expect(content).toMatch(/bind -T copy-mode-vi V send -X select-line\b/)
    expect(content).toMatch(/bind -T copy-mode-vi C-v send -X rectangle-toggle\b/)
  })

  it('binds y/Enter in copy-mode-vi to copy-selection-and-cancel (native tmux buffer, no external clipboard binary)', () => {
    expect(content).toMatch(/bind -T copy-mode-vi y send -X copy-selection-and-cancel\b/)
    expect(content).toMatch(/bind -T copy-mode-vi Enter send -X copy-selection-and-cancel\b/)
  })

  it('does NOT depend on pbcopy or any OS-specific clipboard binary (must work via OSC52 only)', () => {
    expect(content).not.toMatch(/pbcopy/)
  })

  it('enables set-clipboard in "external" mode so copies are forwarded to the local terminal via OSC52', () => {
    expect(content).toMatch(/^set -g set-clipboard external\b/m)
  })

  // 回帰テスト: `set-clipboard on` はtmux自身のコピー操作（copy-mode-viのy/Enter等）
  // だけでなく、ペイン内で動作する任意のプログラムが出力するOSC52エスケープ
  // シーケンスもすべて実端末側のクリップボードへ転送してしまう。このプロジェクトの
  // ターミナル中継処理（terminal-session.ts）はpty→WebSocket間でANSI/OSCの
  // サニタイズを行っていないため、エージェントが表示した任意のファイル内容や
  // コマンド出力にOSC52書き込みシーケンスが埋め込まれていた場合、利用者の操作
  // なしにホストOSのクリップボードが静かに書き換えられ得る（コードレビューで
  // HIGH指摘）。`external`はtmux自身の明示的なコピー操作のみを転送し、ペイン内
  // 任意プログラムの自発的なOSC52送出はブロックするため、素の`on`を使わない。
  it('does NOT use set-clipboard on (only external, to block arbitrary in-pane OSC52 injection)', () => {
    expect(content).not.toMatch(/^set -g set-clipboard on\b/m)
  })

  it('binds prefix+m to toggle mouse mode on/off', () => {
    expect(content).toMatch(/bind m set -g mouse\b/)
  })

  it('enables extended-keys so modified keys (e.g. Shift+Enter) reach the client app', () => {
    expect(content).toMatch(/^set -s extended-keys on\b/m)
    expect(content).toMatch(/terminal-features\s+'xterm\*:extkeys'/)
  })
})

describe('Dockerfile bundles the tmux status-bar config', () => {
  let dockerfileContent: string

  beforeAll(() => {
    dockerfileContent = fs.readFileSync(DOCKERFILE, 'utf-8')
  })

  it('copies docker/tmux.conf to /etc/tmux.conf so it applies to every session regardless of the runtime UID', () => {
    expect(dockerfileContent).toMatch(/COPY docker\/tmux\.conf \/etc\/tmux\.conf\b/)
  })
})
