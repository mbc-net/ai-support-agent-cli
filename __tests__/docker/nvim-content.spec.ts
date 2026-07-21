/**
 * Static analysis tests for the bundled neovim setup.
 *
 * Reads the actual committed docker/nvim/init.lua and docker/Dockerfile (no
 * fs mocking) to verify neovim + its plugin set are installed and baked into
 * the image at build time (not fetched over the network on first use).
 */

import * as fs from 'fs'
import * as path from 'path'

const INIT_LUA = path.resolve(__dirname, '../../docker/nvim/init.lua')
const DOCKERFILE = path.resolve(__dirname, '../../docker/Dockerfile')

describe('docker/nvim/init.lua content validation', () => {
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(INIT_LUA, 'utf-8')
  })

  /**
   * Returns the source text starting at the plugin's `"owner/repo"` spec
   * string, bounded to a window big enough to reach that plugin's own
   * top-level fields (e.g. `commit = "..."`) but not the next plugin entry.
   */
  function pluginBlock(repoSpec: string): string {
    const start = content.indexOf(`"${repoSpec}"`)
    expect(start).toBeGreaterThan(-1)
    return content.slice(start, start + 300)
  }

  it('bootstraps lazy.nvim as the plugin manager', () => {
    expect(content).toMatch(/folke\/lazy\.nvim/)
  })

  it('configures lualine.nvim for the status line', () => {
    expect(content).toMatch(/nvim-lualine\/lualine\.nvim/)
  })

  it('configures fzf-lua for fuzzy file/grep/buffer search', () => {
    expect(content).toMatch(/ibhagwan\/fzf-lua/)
  })

  it('configures nvim-treesitter (main branch) for markdown parsing', () => {
    expect(content).toMatch(/nvim-treesitter\/nvim-treesitter/)
    expect(content).toMatch(/branch = "main"/)
  })

  it('pins nvim-treesitter to a specific commit (not floating "main"), since Neovim itself is pinned to v0.12.4', () => {
    // nvim-treesitter's main branch has no version tags and can raise its
    // Neovim/tree-sitter-CLI requirement at any time; an unpinned `branch =
    // "main"` would silently pull a newer commit on every image rebuild that
    // may no longer work with the Neovim version pinned in the Dockerfile.
    expect(content).toMatch(/commit = "[0-9a-f]{40}"/)
  })

  it('configures render-markdown.nvim for in-buffer markdown rendering', () => {
    expect(content).toMatch(/MeanderingProgrammer\/render-markdown\.nvim/)
  })

  it('uses /bin/bash as the shell (the container has no zsh, unlike the reference config)', () => {
    expect(content).toMatch(/vim\.opt\.shell = "\/bin\/bash"/)
  })

  // 参照設定（koichimurakami/dotfiles の nvim/init.lua）に揃えて追加した項目。
  // SSH/他マシン接続まわり（shell/*-vpn.sh, skhd, wezterm）は対象外。
  it('enables command-line completion menu (wildmenu/wildmode), matching the reference config', () => {
    expect(content).toMatch(/vim\.opt\.wildmenu = true/)
    expect(content).toMatch(/vim\.opt\.wildmode = "longest:full,full"/)
  })

  it('configures csvview.nvim for CSV/TSV column-aligned display', () => {
    expect(content).toMatch(/hat0uma\/csvview\.nvim/)
    expect(content).toMatch(/ft = \{ "csv", "tsv" \}/)
  })

  it('configures rainbow_csv for CSV column rainbow highlighting + RBQL', () => {
    expect(content).toMatch(/mechatroner\/rainbow_csv/)
  })

  it('configures gitsigns.nvim for change signs + hunk stage/reset + line blame', () => {
    expect(content).toMatch(/lewis6991\/gitsigns\.nvim/)
  })

  it('configures neo-tree.nvim (v3.x) as the sidebar file explorer', () => {
    expect(content).toMatch(/nvim-neo-tree\/neo-tree\.nvim/)
    expect(content).toMatch(/branch = "v3\.x"/)
  })

  it('configures diffview.nvim for reviewing diffs/history in a dedicated view', () => {
    expect(content).toMatch(/sindrets\/diffview\.nvim/)
  })

  it('configures lazygit.nvim to launch the lazygit TUI from within nvim', () => {
    expect(content).toMatch(/kdheepak\/lazygit\.nvim/)
  })

  // gitsigns.nvim / neo-tree.nvim / diffview.nvim / lazygit.nvim were added
  // pointing at a branch tip (floating), same as nvim-treesitter above: a
  // rebuild from the same commit of THIS repo could still silently pull a
  // newer, incompatible or compromised upstream commit. Pin each to the
  // specific commit verified via the GitHub API at the time they were added,
  // mirroring the nvim-treesitter `commit = "<40-hex-sha>"` pattern.
  it('pins gitsigns.nvim to a specific commit (not floating on its default branch)', () => {
    expect(pluginBlock('lewis6991/gitsigns.nvim')).toMatch(/commit = "[0-9a-f]{40}"/)
  })

  it('pins neo-tree.nvim to a specific commit on the v3.x branch (not floating)', () => {
    expect(pluginBlock('nvim-neo-tree/neo-tree.nvim')).toMatch(/commit = "[0-9a-f]{40}"/)
  })

  it('pins diffview.nvim to a specific commit (not floating on its default branch)', () => {
    expect(pluginBlock('sindrets/diffview.nvim')).toMatch(/commit = "[0-9a-f]{40}"/)
  })

  it('pins lazygit.nvim to a specific commit (not floating on its default branch)', () => {
    expect(pluginBlock('kdheepak/lazygit.nvim')).toMatch(/commit = "[0-9a-f]{40}"/)
  })
})

describe('Dockerfile bundles a modern neovim + fzf + the plugin set', () => {
  let dockerfileContent: string

  beforeAll(() => {
    dockerfileContent = fs.readFileSync(DOCKERFILE, 'utf-8')
  })

  it('builds neovim from source rather than a prebuilt release tarball', () => {
    // Verified against a real build: neovim's official prebuilt arm64 release
    // tarballs (v0.10.4+, the first to ship a separate arm64 asset) require
    // GLIBC >= 2.38, but this image's base (Debian bookworm) ships GLIBC
    // 2.36 — the prebuilt binary fails at runtime with
    // "version `GLIBC_2.38' not found" on arm64 hosts (e.g. Apple Silicon
    // Docker Desktop, used for local agent CLI runs). Building from source
    // links against whatever glibc the build stage actually has, so it works
    // on both amd64 and arm64 without a version-specific compatibility trap.
    expect(dockerfileContent).toMatch(
      /git clone --depth 1 --branch "\$\{NVIM_VERSION\}" https:\/\/github\.com\/neovim\/neovim/,
    )
    expect(dockerfileContent).toMatch(/make CMAKE_BUILD_TYPE=Release CMAKE_INSTALL_PREFIX=\/opt\/nvim install\b/)
  })

  it('installs neovim\'s from-source build dependencies (ninja, cmake, gettext, pkg-config)', () => {
    expect(dockerfileContent).toMatch(
      /apt-get install -y --no-install-recommends[\s\S]*?ninja-build[\s\S]*?gettext[\s\S]*?cmake[\s\S]*?pkg-config/,
    )
  })

  it('smoke-checks nvim at build time so a broken/missing binary fails the build loudly', () => {
    expect(dockerfileContent).toMatch(/&& nvim --version\b/)
  })

  it('installs the fzf binary that fzf-lua shells out to', () => {
    expect(dockerfileContent).toMatch(/apt-get install -y --no-install-recommends[\s\S]*?\bfzf\b/)
  })

  it('sets XDG dirs to a location writable by any runtime UID, scoped to nvim only via a wrapper script (not a Dockerfile-level ENV)', () => {
    // Mirrors the existing /opt/playwright-browsers pattern for the
    // /opt-based paths: the container may run as root (build time) or an
    // arbitrary UID (entrypoint.sh's dynamic passwd-entry handling for
    // --user), so plugin state must live somewhere both can reach regardless
    // of $HOME.
    //
    // These must NOT be a Dockerfile-level `ENV`, though: that would apply to
    // every process in the container, not just nvim, silently redirecting
    // other XDG-Base-Directory-compliant CLIs (e.g. `gh`, `glab`) to these
    // nvim-specific, world-writable (chmod a+rwX below) directories — e.g.
    // `gh auth login` would write its auth token to a world-writable
    // directory instead of $HOME/.config/gh. Scoping the exports inside the
    // nvim wrapper script itself confines them to nvim's own process tree.
    expect(dockerfileContent).not.toMatch(/^ENV XDG_CONFIG_HOME=/m)
    expect(dockerfileContent).not.toMatch(/^ENV XDG_DATA_HOME=/m)
    expect(dockerfileContent).not.toMatch(/^ENV XDG_STATE_HOME=/m)
    expect(dockerfileContent).not.toMatch(/^ENV XDG_CACHE_HOME=/m)
    expect(dockerfileContent).toMatch(/export XDG_CONFIG_HOME=\/opt\/nvim-config/)
    expect(dockerfileContent).toMatch(/export XDG_DATA_HOME=\/opt\/nvim-data/)
    expect(dockerfileContent).toMatch(/export XDG_STATE_HOME=\/opt\/nvim-state/)
    expect(dockerfileContent).toMatch(/export XDG_CACHE_HOME=\/opt\/nvim-cache/)
  })

  it('renames the built binary to nvim-bin and installs a wrapper at /opt/nvim/bin/nvim that sets XDG_* before exec-ing it', () => {
    expect(dockerfileContent).toMatch(
      /mv \/opt\/nvim\/bin\/nvim \/opt\/nvim\/bin\/nvim-bin\b/,
    )
    expect(dockerfileContent).toMatch(
      /exec \/opt\/nvim\/bin\/nvim-bin "\$@"/,
    )
    expect(dockerfileContent).toMatch(/chmod \+x \/opt\/nvim\/bin\/nvim\b/)
  })

  it('copies docker/nvim/init.lua into /opt/nvim-config/nvim/init.lua (a literal path, since XDG_CONFIG_HOME is no longer a Dockerfile-level ENV)', () => {
    expect(dockerfileContent).toMatch(
      /COPY docker\/nvim\/init\.lua \/opt\/nvim-config\/nvim\/init\.lua\b/,
    )
  })

  it('pre-installs the plugin set at build time via headless lazy.nvim sync (no first-use network fetch)', () => {
    expect(dockerfileContent).toMatch(/nvim --headless "\+Lazy! sync" \+qa/)
  })

  it('fails the build loudly if any plugin did not actually install (verified against a real build: `Lazy! sync` exits 0 even when a clone fails)', () => {
    // Verified empirically: pointing a plugin at a nonexistent repo makes
    // `nvim --headless "+Lazy! sync" +qa` print an error but still exit 0,
    // so the RUN step alone cannot be trusted to fail the build on its own.
    // A follow-up headless check against lazy.nvim's own installed-state
    // (plugin._.installed) must run and exit non-zero (vim.cmd("cquit 1"))
    // when anything is missing.
    expect(dockerfileContent).toMatch(/p\._\.installed/)
    expect(dockerfileContent).toMatch(/cquit 1/)
  })

  it('waits for the markdown/markdown_inline treesitter parser install (an async task) to finish and verifies it at build time', () => {
    // require("nvim-treesitter").install(...) (called from init.lua's config
    // function) returns an async.Task without being awaited there — fine for
    // interactive use, but at build time the RUN step would move on to
    // chmod/qa before the parser is actually compiled, silently shipping an
    // image without it. install() returns a Task with :wait(timeout)
    // (verified against nvim-treesitter's vendored async.lua at the pinned
    // commit), so the build explicitly waits on it and fails loudly
    // (cquit 1) if either parser did not end up installed.
    expect(dockerfileContent).toMatch(
      /require\('nvim-treesitter'\)\.install\(\{'markdown','markdown_inline'\}\):wait\(\d+\)/,
    )
    expect(dockerfileContent).toMatch(/get_installed\(\)/)
  })

  it('installs the tree-sitter CLI, which nvim-treesitter shells out to when building a parser', () => {
    // Verified against a real build: without it, parser install fails with
    // "Error during \"tree-sitter build\": ENOENT: no such file or
    // directory (cmd): 'tree-sitter'" — the Lazy-sync-succeeded /
    // plugin._.installed checks above don't catch this because the plugin
    // ITSELF installs fine; only the parser BUILD step needs this binary.
    expect(dockerfileContent).toMatch(/&& tree-sitter --version\b/)
  })

  it('builds the tree-sitter CLI from source via cargo, not the prebuilt npm/GitHub-release binary', () => {
    // Verified against a real build: both the tree-sitter-cli npm package
    // and tree-sitter/tree-sitter's own GitHub release arm64 binary are
    // linked against GLIBC >= 2.39 — the same class of trap as neovim's
    // prebuilt arm64 tarball above, and this bookworm base only has GLIBC
    // 2.36. rustc/cargo from apt (bookworm ships 1.63) are old enough that
    // tree-sitter-cli may not build (MSRV), so rustup installs a current
    // stable toolchain instead, mirroring this Dockerfile's other
    // official-install-script tools (starship, code-server).
    expect(dockerfileContent).toMatch(/rustup\.rs/)
    expect(dockerfileContent).toMatch(/cargo install tree-sitter-cli\b/)
  })

  it('pins both the Rust toolchain and tree-sitter-cli to exact, verified versions (not floating stable/latest)', () => {
    // Otherwise the nvim-treesitter commit pinned above (chosen specifically
    // for compatibility with this Neovim version) could stop building the
    // moment rustup's "stable" or an unpinned `cargo install` picks up a
    // newer toolchain/crate release with a different MSRV or API — the same
    // reproducibility gap the commit pin was meant to close.
    expect(dockerfileContent).toMatch(/--default-toolchain \d+\.\d+\.\d+\b/)
    expect(dockerfileContent).toMatch(/cargo install tree-sitter-cli --version \d+\.\d+\.\d+ --locked\b/)
  })

  it('makes the baked-in plugin/config dirs readable and writable by any runtime UID', () => {
    expect(dockerfileContent).toMatch(
      /chmod -R a\+rwX \/opt\/nvim-config \/opt\/nvim-data \/opt\/nvim-state \/opt\/nvim-cache\b/,
    )
  })
})
