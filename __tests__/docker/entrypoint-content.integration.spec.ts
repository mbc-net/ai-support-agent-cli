/**
 * Tests for the bundled docker/entrypoint.sh.
 *
 * Most of the docker/*-content.spec.ts files in this directory are purely
 * static (regex over the committed file). entrypoint.sh's safe.directory
 * auto-registration is security-relevant (git trust scoping) and easy to
 * get subtly wrong (e.g. wrong `find` flags, wrong loop quoting dropping
 * paths with spaces), so this one actually executes the real script against
 * a real temp git repo tree with real git — a regex match on the source
 * text cannot prove the registered paths are actually correct.
 */

import { execFileSync, spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const ENTRYPOINT_SH = path.resolve(__dirname, '../../docker/entrypoint.sh')

describe('docker/entrypoint.sh content validation (static)', () => {
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(ENTRYPOINT_SH, 'utf-8')
  })

  it('does NOT use the global safe.directory wildcard (trust must stay scoped to discovered repos)', () => {
    expect(content).not.toMatch(/safe\.directory\s+['"]?\*/)
  })
})

describe('docker/entrypoint.sh safe.directory auto-registration (real execution)', () => {
  let tmpRoot: string
  let workspaceDir: string
  let fakeHome: string

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'entrypoint-sh-test-'))
    workspaceDir = path.join(tmpRoot, 'workspace')
    fakeHome = path.join(tmpRoot, 'home')
    fs.mkdirSync(workspaceDir, { recursive: true })
    fs.mkdirSync(fakeHome, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  /** Run entrypoint.sh against the temp workspace, with `true` as the exec'd command. */
  function runEntrypoint(): void {
    execFileSync('sh', [ENTRYPOINT_SH, 'true'], {
      env: {
        ...process.env,
        HOME: fakeHome,
        AI_SUPPORT_AGENT_WORKSPACE_DIR: workspaceDir,
      },
      timeout: 10_000,
    })
  }

  /** Run entrypoint.sh and capture stderr (unlike execFileSync, which discards it on success). */
  function runEntrypointCapture(): { stderr: string; status: number | null } {
    const result = spawnSync('sh', [ENTRYPOINT_SH, 'true'], {
      env: {
        ...process.env,
        HOME: fakeHome,
        AI_SUPPORT_AGENT_WORKSPACE_DIR: workspaceDir,
      },
      timeout: 10_000,
      encoding: 'utf-8',
    })
    return { stderr: result.stderr, status: result.status }
  }

  /**
   * Reads back the registered safe.directory values from the fake $HOME's
   * git config. `git config --get-all` exits 1 (documented) when there are
   * simply no entries yet — that's the only case treated as "none
   * registered". Any other failure (missing git binary, unreadable $HOME,
   * ...) is a real infra problem unrelated to what these tests assert, and
   * must not be silently folded into the same "empty list" result — that
   * would let e.g. "does not fail when the workspace has no git
   * repositories" pass for the wrong reason.
   */
  function getRegisteredSafeDirectories(): string[] {
    try {
      const out = execFileSync('git', ['config', '--global', '--get-all', 'safe.directory'], {
        env: { ...process.env, HOME: fakeHome },
        encoding: 'utf-8',
      })
      return out.split('\n').filter(Boolean)
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 1) return []
      throw error
    }
  }

  function initFakeRepo(relDir: string): string {
    const repoDir = path.join(workspaceDir, relDir)
    fs.mkdirSync(repoDir, { recursive: true })
    execFileSync('git', ['init', '-q', repoDir])
    return repoDir
  }

  it('registers a git repository directly under the workspace root', () => {
    const repoDir = initFakeRepo('projects/AI_SUPPORT_AGENT')

    runEntrypoint()

    expect(getRegisteredSafeDirectories()).toContain(repoDir)
  })

  it('registers a git repository nested several levels deep (e.g. a synced sub-repo)', () => {
    const repoDir = initFakeRepo('projects/JCCI_ECO/repos/some-repo')

    runEntrypoint()

    expect(getRegisteredSafeDirectories()).toContain(repoDir)
  })

  it('registers multiple repositories found under the workspace', () => {
    const repoA = initFakeRepo('projects/A')
    const repoB = initFakeRepo('projects/B/repos/x')

    runEntrypoint()

    const registered = getRegisteredSafeDirectories()
    expect(registered).toContain(repoA)
    expect(registered).toContain(repoB)
  })

  it('does not fail when the workspace has no git repositories at all', () => {
    expect(() => runEntrypoint()).not.toThrow()
    expect(getRegisteredSafeDirectories()).toEqual([])
  })

  it('does not fail when the workspace directory itself does not exist', () => {
    fs.rmSync(workspaceDir, { recursive: true, force: true })

    expect(() => runEntrypoint()).not.toThrow()
  })

  it('does NOT register the workspace root itself, only the actual repository directories', () => {
    initFakeRepo('projects/A')

    runEntrypoint()

    expect(getRegisteredSafeDirectories()).not.toContain(workspaceDir)
  })

  // 回帰テスト: レビュー指摘（この対策コード自体が無音に失敗しうる問題）。
  // find が権限で弾かれたサブツリーに当たっても、(1) 他の正当なリポジトリの
  // 登録は継続し、(2) 失敗した旨が stderr に残ることを確認する。
  it('warns on stderr (but still registers other repos) when find hits an unreadable subtree', () => {
    const repoA = initFakeRepo('projects/A')
    const blockedDir = path.join(workspaceDir, 'projects', 'blocked')
    fs.mkdirSync(blockedDir, { recursive: true })
    fs.chmodSync(blockedDir, 0o000)

    try {
      const { stderr } = runEntrypointCapture()

      expect(getRegisteredSafeDirectories()).toContain(repoA)
      expect(stderr).toMatch(/WARN.*scanning/i)
    } finally {
      // afterEach の rmSync がこのディレクトリを削除できるよう権限を戻す
      fs.chmodSync(blockedDir, 0o755)
    }
  })

  it('warns on stderr when registering a repo fails (e.g. $HOME unwritable)', () => {
    initFakeRepo('projects/A')
    // $HOME/.gitconfig への書き込みができない状態を作る
    // ($HOME 自体を書き込み不可にする)
    fs.chmodSync(fakeHome, 0o500)

    try {
      const { stderr } = runEntrypointCapture()

      expect(stderr).toMatch(/WARN: failed to register git safe\.directory/)
    } finally {
      fs.chmodSync(fakeHome, 0o755)
    }
  })
})
