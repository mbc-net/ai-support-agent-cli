/**
 * Static analysis tests for the "make the terminal look nice" setup:
 * starship prompt, eza (ls replacement), bat (cat replacement), and a
 * neovim colorscheme. Reads the actual committed docker/Dockerfile and
 * docker/nvim/init.lua (no fs mocking).
 */

import * as fs from 'fs'
import * as path from 'path'

const DOCKERFILE = path.resolve(__dirname, '../../docker/Dockerfile')
const INIT_LUA = path.resolve(__dirname, '../../docker/nvim/init.lua')

describe('Dockerfile: shell prompt / ls / cat replacements', () => {
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(DOCKERFILE, 'utf-8')
  })

  it('installs starship via its official install script, pinned to a specific version', () => {
    // Unpinned (no --version) would let a future starship release change
    // behavior/output silently on the next image build.
    expect(content).toMatch(
      /curl -sS https:\/\/starship\.rs\/install\.sh \| sh -s -- --yes --version /,
    )
  })

  it('smoke-checks starship at build time so a broken/missing binary fails the build loudly', () => {
    expect(content).toMatch(/&& starship --version\b/)
  })

  it('installs eza (dual-arch GitHub release binary, not available via apt on bookworm)', () => {
    expect(content).toMatch(
      /eza_\$\{?EZA_ARCH\}?-unknown-linux-gnu\.tar\.gz|eza_aarch64-unknown-linux-gnu\.tar\.gz/,
    )
    expect(content).toMatch(/&& eza --version\b/)
  })

  it('installs bat via apt (Debian ships the binary as /usr/bin/batcat, not /usr/bin/bat)', () => {
    expect(content).toMatch(/apt-get install -y --no-install-recommends[\s\S]*?\bbat\b/)
  })

  it('appends the starship/eza/bat setup into /etc/bash.bashrc', () => {
    // /etc/profile.d/*.sh only runs for LOGIN shells. The agent's real
    // terminal session spawns bash with `--rcfile <tmp>/.bashrc` (see
    // terminal-session.ts / sandbox-init-script.ts's buildBashRcContent,
    // which sources ~/.bashrc, not /etc/profile.d). Verified empirically:
    // Debian's bash still sources /etc/bash.bashrc even with --rcfile set,
    // so that is the file that must carry this setup.
    expect(content).toMatch(/COPY docker\/bashrc-extra\.sh \/tmp\/bashrc-extra\.sh/)
    expect(content).toMatch(/cat \/tmp\/bashrc-extra\.sh >> \/etc\/bash\.bashrc\b/)
  })
})

describe('docker/bashrc-extra.sh content validation', () => {
  const BASHRC_EXTRA = path.resolve(__dirname, '../../docker/bashrc-extra.sh')
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(BASHRC_EXTRA, 'utf-8')
  })

  it('initializes the starship prompt', () => {
    expect(content).toMatch(/eval "\$\(starship init bash\)"/)
  })

  it('aliases ls to eza with icons', () => {
    expect(content).toMatch(/alias ls=['"]eza --icons['"]/)
  })

  it('aliases cat to batcat with paging disabled (the actual binary name shipped by Debian, --paging=never): bat defaults to paging via less when stdout is a tty and content overflows, reintroducing the exact interactive-pager-hang risk that core.pager=cat was added to eliminate for this AI-agent-driven PTY session', () => {
    expect(content).toMatch(/alias cat=['"]?batcat --paging=never['"]?/)
  })
})

describe('docker/nvim/init.lua: colorscheme', () => {
  let content: string

  beforeAll(() => {
    content = fs.readFileSync(INIT_LUA, 'utf-8')
  })

  it('sets a non-default colorscheme for readability', () => {
    expect(content).toMatch(/vim\.cmd\.colorscheme\(["']habamax["']\)/)
  })
})
