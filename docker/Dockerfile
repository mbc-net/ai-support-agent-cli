FROM ubuntu:26.04

# =============================================================================
# Layer 1: OS packages (most stable — rarely changes)
# =============================================================================
# Bump this date to force a full rebuild of the apt layers (e.g. to pick up a
# batch of Ubuntu security updates on an otherwise cached build host).
ARG APT_CACHE_BUST=2026-11-09
# Build-time only (ARG, not ENV): keeps apt/debconf from prompting (e.g.
# tzdata's region question) without leaking DEBIAN_FRONTEND into the runtime
# environment of the agent or of images derived from this one.
ARG DEBIAN_FRONTEND=noninteractive
# `apt-get update` is retried (3 attempts, 5s/15s backoff) at every occurrence in
# this file to absorb transient DNS/network failures reaching the Ubuntu
# archive (e.g. Docker daemon DNS hiccups on Ubuntu 24.04+ hosts) that would
# otherwise abort the whole build on the first hit.
RUN (apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update)) \
    && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git openssh-client vim jq \
    # xz-utils: the Node.js release tarball below is .tar.xz. tzdata: the
    # agent forwards the host TZ (volume-mount-builder.ts) and libc needs
    # /usr/share/zoneinfo to honour it. adduser: shipped in the previous
    # Debian-based image, kept so derived per-project images can rely on it.
    # (ubuntu:26.04 ships none of the three; node:24-slim had tzdata/adduser.)
    xz-utils tzdata adduser \
    # sshpass: Ansible's `ssh` connection plugin shells out to this for
    # ansible_ssh_pass (password-authType server_setup_exec hosts); without
    # it, ansible-playbook fails to authenticate against password-only hosts.
    sshpass \
    default-mysql-client postgresql-client \
    gnupg apt-transport-https \
    # Build tools for native addons (node-pty)
    make g++ \
    # Network diagnostic tools (for server troubleshooting). Ubuntu 26.04 no
    # longer has the `dnsutils` transitional package; bind9-dnsutils is the
    # real package that ships dig/nslookup/host.
    iputils-ping net-tools bind9-dnsutils whois traceroute netcat-openbsd iproute2 \
    # Terminal multiplexer (auto-attached for each agent console session)
    tmux \
    # fzf-lua (nvim plugin) shells out to this for fuzzy file/grep/buffer search
    fzf \
    # cat replacement with syntax highlighting (Debian/Ubuntu ship the binary
    # as /usr/bin/batcat, not /usr/bin/bat, due to a package name clash)
    bat \
    # Python 3 + pip (for document processing tools, ansible-core and node-gyp).
    # Ubuntu 26.04's python3 is 3.14.
    python3 python3-pip python3-venv \
    # Pandoc (universal document converter: docx/pdf/html/markdown/etc.)
    pandoc \
    # PDF rendering support for Python PDF libraries
    libpoppler-cpp-dev poppler-utils \
    # Locale support (for Japanese filenames etc.)
    locales \
    # Japanese fonts (for Playwright Chromium to render Japanese websites)
    fonts-noto-cjk \
    && locale-gen en_US.UTF-8 \
    && locale -a | grep -qx 'en_US.utf8' \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# git branch/log/diff/show default to piping through an interactive pager
# (less) whenever stdout is a tty. This shell is driven by an AI agent over a
# PTY with no human at the keyboard to press "q" — an interactive pager left
# enabled means any such command can hang forever waiting for input that
# never comes. core.pager=cat makes these commands print directly, with no
# pager and no risk of blocking the session.
RUN git config --system core.pager cat

# =============================================================================
# Layer 1b: Node.js runtime + the `node` user (mirrors the former node:24 base)
# =============================================================================
# The image used to be `FROM node:24-slim`. Ubuntu 26.04's own nodejs package
# is Node 22, so Node 24 is installed from the official nodejs.org release
# tarball into /usr/local exactly like the node:24 images do: node/npm/npx/
# corepack end up in /usr/local/bin and npm's global prefix stays /usr/local
# (Layer 6 and src/docker/docker-utils.ts rely on
# /usr/local/lib/node_modules/@ai-support-agent/cli). Pinned and verified: the
# SHA-256 values are the ones published in nodejs.org's SHASUMS256.txt for
# this release and were cross-checked by downloading and hashing each tarball.
# NODE_VERSION / YARN_VERSION are exported like the node images do, and Yarn
# classic is installed because the node:24 images shipped it.
ARG NODE_VERSION=24.22.2
ARG NODE_SHA256_X64=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
ARG NODE_SHA256_ARM64=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8
ARG YARN_VERSION=1.22.22
ENV NODE_VERSION=${NODE_VERSION} YARN_VERSION=${YARN_VERSION}
RUN ARCH=$(dpkg --print-architecture) \
    && case "$ARCH" in \
         amd64) NODE_ARCH="x64"; NODE_SHA256="$NODE_SHA256_X64" ;; \
         arm64) NODE_ARCH="arm64"; NODE_SHA256="$NODE_SHA256_ARM64" ;; \
         *) echo "ERROR: unsupported architecture for Node.js: $ARCH" >&2; exit 1 ;; \
       esac \
    && curl -fSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
        -o /tmp/node.tar.xz \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
    && rm -f /tmp/node.tar.xz /usr/local/CHANGELOG.md /usr/local/LICENSE /usr/local/README.md \
    && ln -s /usr/local/bin/node /usr/local/bin/nodejs \
    && [ "$(node --version)" = "v${NODE_VERSION}" ] \
    && npm --version \
    && npm install -g "yarn@${YARN_VERSION}" \
    && npm cache clean --force \
    && [ "$(yarn --version)" = "${YARN_VERSION}" ]
# node:24 images ship a `node` user (uid/gid 1000, HOME /home/node, bash).
# ubuntu:26.04 instead ships `ubuntu` with the same uid/gid 1000, so rename it
# rather than add a second account: when docker-runner.ts passes
# `--user 1000:1000` (the usual first user on a Linux host), the container
# user must still resolve to `node` with /home/node, which is CONTAINER_HOME
# (src/constants.ts) and the mount target for ~/.claude, ~/.codex, ~/.aws, ...
# The checks fail the build if the result differs from the old base.
RUN usermod -l node -d /home/node -m -c '' ubuntu \
    && groupmod -n node ubuntu \
    && [ "$(getent passwd node)" = "node:x:1000:1000::/home/node:/bin/bash" ] \
    && [ "$(getent group node)" = "node:x:1000:" ] \
    && ! getent passwd ubuntu \
    && [ -d /home/node ] && [ ! -e /home/ubuntu ]

# =============================================================================
# Layer 2: Python tools (stable — version-pinned)
# =============================================================================
RUN pip3 install --no-cache-dir --break-system-packages \
    # PDF: read, write, merge, split, extract text
    'pypdf>=6.7.2,<7' \
    # PDF: extract text with layout preservation (better than pypdf for complex layouts)
    pdfplumber==0.* \
    # Word (.docx): read and write
    python-docx==1.* \
    # PowerPoint (.pptx): read and write
    python-pptx==1.* \
    # Excel (.xlsx): read and write
    openpyxl==3.* \
    # HTML/XML parsing (for document content extraction)
    beautifulsoup4==4.* \
    # lxml 6: lxml 5.x has no CPython 3.14 wheel and fails to build from source
    # on Ubuntu 26.04 (verified); 6.x ships 3.14 wheels.
    lxml==6.* \
    # Character encoding detection (for legacy files)
    chardet==5.* \
    # Server setup execution: runs a dynamically generated playbook (built by
    # generatePlaybook() in src/server-setup/server-setup-runner.ts, written to
    # a per-run temp dir — NOT the static agent/ansible/playbook.yml, which is
    # unused at runtime) against target hosts.
    # Pinned to a range validated against ansible/callback_plugins/json.py and
    # ansible/roles/database (CallbackBase's v2_runner_on_*/v2_playbook_on_stats
    # hooks and module result shapes are internal APIs, not covered by ansible-core's
    # semver-ish compatibility promise) rather than the previous unbounded `2.*`,
    # which could silently pick up a future major ansible-core release with
    # changed callback internals.
    # 2.20 (not the former 2.16/2.17): ansible-core 2.17 does not support the
    # image's Python 3.14 as a controller (2.20 is the first line that does),
    # and the bundled Zabbix roles for Ubuntu 26.04 hosts need a >= 2.20
    # controller. Kept to a single minor line (<2.21) for the same
    # internal-API reason as above; patch releases are bug/security fixes.
    # Managed hosts need Python >= 3.9 under 2.20 (Ubuntu 20.04 / Debian 10
    # hosts are no longer reachable from this controller).
    'ansible-core>=2.20,<2.21'

# Ansible collections used by ansible/roles/database/tasks/main.yml to set the
# MySQL root / PostgreSQL postgres admin password via a proper module
# parameter (ansible.mysql.mysql_user / community.postgresql.postgresql_user)
# instead of interpolating the password into a raw SQL string, which would be
# vulnerable to SQL injection via a password containing a single quote.
# `ansible.mysql` is used rather than the now-deprecated
# `community.mysql.mysql_user` (removal planned for community.mysql 6.0.0).
# `ansible.posix` provides `authorized_key`, used by
# ansible/roles/ssh_key/tasks/main.yml to add SSH public keys to a target
# user's ~/.ssh/authorized_keys. This module is allowlisted in
# src/server-setup/ansible-task-guard.ts's *base* MODULE_ALLOWLIST (both ecs
# and resident routes), so it must be installed here unconditionally, not
# gated behind the database role's collections.
# Version ranges pinned for the same reproducibility reason as ansible-core
# above — an unbounded install could silently pick up a future major release
# with a changed module interface (e.g. mysql_user/postgresql_user/
# authorized_key parameter shape) that the bundled roles weren't validated
# against.
# `ansible.windows` / `community.windows` are needed for server setup on
# Windows hosts over OpenSSH (admin-docs server-setup-windows-openssh.md §5.6).
# Pinned to exact versions — the same ones as `collections` in
# src/server-setup/windows-guard.json, whose per-module argument allowlists were
# surveyed against them (checked by __tests__/server-setup/ansible-collections-sync.spec.ts).
# Both require ansible-core >=2.16, so they are satisfied by the 2.20 pin above
# (all five collections verified to install under ansible-core 2.20).
# Installed to /usr/share/ansible/collections — one of ansible-core's default
# collection search paths regardless of the runtime user's $HOME — so the
# collections are found no matter which UID the container ultimately runs as
# (see docker/entrypoint.sh's dynamic passwd-entry handling for --user).
RUN ansible-galaxy collection install \
    'ansible.mysql:>=5.0.0,<6.0.0' \
    'community.postgresql:>=4.0.0,<5.0.0' \
    'ansible.posix:>=1.5.0,<2.0.0' \
    'ansible.windows:3.8.0' \
    'community.windows:3.3.0' \
    -p /usr/share/ansible/collections \
    && chmod -R a+rX /usr/share/ansible/collections

# =============================================================================
# Layer 3: System CLIs — external binary downloads (stable, rarely changes)
# Combined into as few RUN steps as possible to minimise layer count while
# keeping logically distinct tools separable when they do need updating.
# =============================================================================

# AWS CLI v2 + Session Manager Plugin
# Note: AWS uses "ubuntu_64bit" for x86_64/amd64 and "ubuntu_arm64" for arm64
RUN curl -fSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip \
    && unzip /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip \
    && ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "amd64" ]; then SSM_ARCH="64bit"; else SSM_ARCH="$ARCH"; fi \
    && curl -fSL "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_${SSM_ARCH}/session-manager-plugin.deb" \
        -o /tmp/session-manager-plugin.deb \
    && dpkg -i /tmp/session-manager-plugin.deb \
    && rm /tmp/session-manager-plugin.deb

# Neovim, built from source (pinned tag) — Ubuntu 26.04's apt "neovim"
# package is 0.11.x, too old for the nvim-treesitter main-branch API used by
# docker/nvim/init.lua (see the v0.12 note below). Building from source
# rather than using neovim's prebuilt release tarballs links the binary
# against the glibc this build stage actually has, so it can never require a
# newer glibc than the base image provides. That is not hypothetical: on the
# previous Debian bookworm base (glibc 2.36) the prebuilt arm64 tarball
# failed at runtime with "version `GLIBC_2.38' not found" (Apple Silicon
# Docker Desktop). One Dockerfile path works on both amd64 and arm64 with no
# base-version-specific compatibility trap.
#
# Pinned to v0.12.4, not v0.10.4: verified against a real build that
# nvim-treesitter's main branch (pinned by commit below) calls
# vim.list.unique(), added in Neovim v0.12.0 ("feat(lua): add
# vim.list.unique()") — on v0.10.4 the parser install step fails with
# "attempt to index field 'list' (a nil value)".
RUN (apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update)) \
    && apt-get install -y --no-install-recommends \
    ninja-build gettext cmake pkg-config \
    && rm -rf /var/lib/apt/lists/*
ARG NVIM_VERSION=v0.12.4
# The real binary is renamed to nvim-bin and /opt/nvim/bin/nvim becomes a
# thin wrapper that exports the XDG_* vars (see the config block below) only
# for nvim's own process tree, then execs the real binary. This keeps
# /opt/nvim/bin/nvim as the stable path referenced by the symlink below and
# by update-alternatives further down — only what that path points AT
# changes (binary -> wrapper) — while confining the nvim-specific XDG
# redirection to nvim itself instead of leaking it to every process in the
# container via a Dockerfile-level ENV (see the config block below for why
# that matters).
RUN git clone --depth 1 --branch "${NVIM_VERSION}" https://github.com/neovim/neovim /tmp/neovim-src \
    && cd /tmp/neovim-src \
    && make CMAKE_BUILD_TYPE=Release CMAKE_INSTALL_PREFIX=/opt/nvim install \
    && mv /opt/nvim/bin/nvim /opt/nvim/bin/nvim-bin \
    && printf '#!/bin/sh\nexport XDG_CONFIG_HOME=/opt/nvim-config\nexport XDG_DATA_HOME=/opt/nvim-data\nexport XDG_STATE_HOME=/opt/nvim-state\nexport XDG_CACHE_HOME=/opt/nvim-cache\nexec /opt/nvim/bin/nvim-bin "$@"\n' > /opt/nvim/bin/nvim \
    && chmod +x /opt/nvim/bin/nvim \
    && ln -s /opt/nvim/bin/nvim /usr/local/bin/nvim \
    && rm -rf /tmp/neovim-src \
    && nvim --version

# tree-sitter CLI — nvim-treesitter's parser install shells out to this to
# compile grammars (verified against a real build: without it, parser
# install fails with "Error during \"tree-sitter build\": ENOENT ...
# 'tree-sitter'"). Built from source via cargo, for the same reason as neovim
# above: the prebuilt tree-sitter-cli binaries (npm package / GitHub release)
# are linked against whatever glibc upstream's CI had (>= 2.39 at the time
# this was written), which a base image is not guaranteed to provide. The
# toolchain comes from rustup rather than apt so its version is pinned here
# explicitly instead of drifting with the distro's rustc (and so a distro
# rustc older than tree-sitter-cli's MSRV can never break the build),
# mirroring this Dockerfile's other official-install-script tools (starship,
# code-server below). Both the toolchain and the crate are pinned to exact versions
# verified against a real build — not "stable"/unpinned "latest" — since the
# nvim-treesitter commit above was pinned specifically for compatibility
# with THIS build; an unpinned toolchain/crate bump could silently break that
# compatibility on the next image rebuild with no source change here.
RUN (apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update)) \
    && apt-get install -y --no-install-recommends libclang-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.97.1 \
    && . "$HOME/.cargo/env" \
    && cargo install tree-sitter-cli --version 0.26.11 --locked --root /usr/local \
    && rm -rf "$HOME/.rustup" "$HOME/.cargo" \
    && tree-sitter --version

# Neovim config + plugin set, pre-installed at build time so the agent shell
# doesn't need network access on first use. These paths are baked into the
# nvim wrapper script above (not a Dockerfile-level ENV) so they apply only
# when nvim itself runs — not to every process in the container (a
# Dockerfile-level ENV here would also redirect unrelated XDG-compliant CLIs
# like `gh` to these nvim-specific, world-writable directories; see
# security review finding for src/security.ts SAFE_ENV_KEYS).
# XDG dirs point at /opt rather than $HOME: $HOME differs depending on
# whether the container runs as root (build time) or an arbitrary UID
# (entrypoint.sh's dynamic passwd-entry handling for --user), the same
# reasoning as /opt/playwright-browsers below.
RUN mkdir -p /opt/nvim-config/nvim
COPY docker/nvim/init.lua /opt/nvim-config/nvim/init.lua
RUN nvim --headless "+Lazy! sync" +qa \
    && nvim --headless -c "lua local missing={} for _,p in pairs(require('lazy').plugins()) do if not p._.installed then table.insert(missing,p.name) end end if #missing>0 then print('MISSING PLUGINS: '..table.concat(missing,', ')) vim.cmd('cquit 1') end" -c "qa" \
    && nvim --headless -c "lua require('nvim-treesitter').install({'markdown','markdown_inline'}):wait(300000)" -c "qa" \
    && nvim --headless -c "lua local installed={} for _,l in ipairs(require('nvim-treesitter.config').get_installed()) do installed[l]=true end if not (installed.markdown and installed.markdown_inline) then print('MISSING TREESITTER PARSERS') vim.cmd('cquit 1') end" -c "qa" \
    && chmod -R a+rwX /opt/nvim-config /opt/nvim-data /opt/nvim-state /opt/nvim-cache

# nvim をデフォルトエディタにする（git commit 等が $EDITOR/$VISUAL を参照する）
ENV EDITOR=nvim VISUAL=nvim

# vi/vim コマンド自体もnvimを指すようにする（apt版vim.basicの優先度30より
# 高い60を指定し、update-alternativesでnvimを優先させる。実機検証済み）
# --install は候補として登録できたことしか保証しないため、実際に
# /usr/bin/vi・/usr/bin/vim がnvimへ解決され、かつ実行できることまで
# ビルド時に検証する（readlink -fでのパス一致 + --versionのNVIMバナー確認）。
RUN update-alternatives --install /usr/bin/vi vi /opt/nvim/bin/nvim 60 \
    && update-alternatives --install /usr/bin/vim vim /opt/nvim/bin/nvim 60 \
    && [ "$(readlink -f /usr/bin/vi)" = "/opt/nvim/bin/nvim" ] \
    && [ "$(readlink -f /usr/bin/vim)" = "/opt/nvim/bin/nvim" ] \
    && vi --version | grep -q NVIM \
    && vim --version | grep -q NVIM

# starship prompt (pinned version — the install script's --version pins
# it to a verified release rather than tracking "latest" across rebuilds)
RUN curl -sS https://starship.rs/install.sh | sh -s -- --yes --version v1.26.0 \
    && starship --version
# 実行時UID（entrypoint.shが動的に割り当てる）に依存せず全セッションに
# 同じプロンプト設定を適用するため、$HOME/.config/starship.toml ではなく
# 固定パスをSTARSHIP_CONFIGで明示する（/etc/tmux.confと同じパターン）。
ENV STARSHIP_CONFIG=/etc/starship.toml

# eza (ls replacement with icons) — a dual-arch GitHub release binary pinned
# to EZA_VERSION. (Introduced when the base was Debian bookworm, which did not
# package eza; Ubuntu 26.04 packages 0.23.4, but the pinned upstream release
# is kept so the base-image migration does not also change the eza version.
# The release binary links against an older glibc than Ubuntu 26.04's 2.43.)
ARG EZA_VERSION=v0.23.5
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then EZA_ARCH="aarch64"; else EZA_ARCH="x86_64"; fi \
    && curl -fSL "https://github.com/eza-community/eza/releases/download/${EZA_VERSION}/eza_${EZA_ARCH}-unknown-linux-gnu.tar.gz" \
        -o /tmp/eza.tar.gz \
    && mkdir -p /tmp/eza-extract \
    && tar -xzf /tmp/eza.tar.gz -C /tmp/eza-extract \
    && mv /tmp/eza-extract/eza /usr/local/bin/eza \
    && rm -rf /tmp/eza.tar.gz /tmp/eza-extract \
    && eza --version

# lazygit (TUI git client, shelled out to by the lazygit.nvim plugin in
# docker/nvim/init.lua) — Ubuntu 26.04's lazygit package is 0.57, older than
# the release pinned here, so a dual-arch GitHub release binary is
# downloaded, following the same pattern as eza above.
#
# Code review (second opinion) flagged that the download had no integrity
# check: if the GitHub release asset or the delivery path were ever tampered
# with, the resulting binary would be installed and executed as-is — the
# trailing `lazygit --version` smoke check happily "passes" for a malicious
# binary too, since it only proves *a* binary ran, not that it's the genuine
# release. The SHA-256 values below were taken from lazygit's own
# `checksums.txt` release asset and cross-verified by independently
# downloading each tarball and hashing it locally before pinning.
ARG LAZYGIT_VERSION=0.63.1
ARG LAZYGIT_SHA256_X86_64=8e033bc78c8e192dee9510e951f6c9e154289b7198d22c924ed1d0a951b0dac1
ARG LAZYGIT_SHA256_ARM64=555dbc9a8efcf2e33bc24e7fbd9463e9fa375e3c5e23cc270763733c38eeae36
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then LAZYGIT_ARCH="arm64"; LAZYGIT_SHA256="$LAZYGIT_SHA256_ARM64"; else LAZYGIT_ARCH="x86_64"; LAZYGIT_SHA256="$LAZYGIT_SHA256_X86_64"; fi \
    && curl -fSL "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_linux_${LAZYGIT_ARCH}.tar.gz" \
        -o /tmp/lazygit.tar.gz \
    && echo "${LAZYGIT_SHA256}  /tmp/lazygit.tar.gz" | sha256sum -c - \
    && mkdir -p /tmp/lazygit-extract \
    && tar -xzf /tmp/lazygit.tar.gz -C /tmp/lazygit-extract \
    && mv /tmp/lazygit-extract/lazygit /usr/local/bin/lazygit \
    && rm -rf /tmp/lazygit.tar.gz /tmp/lazygit-extract \
    && lazygit --version

# Tailscale (tailscaled + tailscale CLI) for the Web RDP Tailscale route.
# src/rdp/rdp-tunnel-tailscale.ts starts one userspace tailscaled per RDP
# session (--tun=userspace-networking, in-memory state, its LocalAPI
# unix socket inside a private 0700 temp directory) and carries each connection
# over `tailscale nc <host> <port>` (run with --socket=<that socket>) on
# stdin/stdout.
# No TCP port is opened for it, nothing here runs at container start, and no
# TUN device or extra capability is needed. The agent reports the tailscale
# route on its heartbeat only when both binaries are on PATH
# (rdp-tunnel-support.ts).
# Official static tarballs, pinned and verified: the SHA-256 values match the
# `.sha256` files published next to each tarball on pkgs.tailscale.com and were
# cross-checked by downloading and hashing each tarball locally.
ARG TAILSCALE_VERSION=1.102.4
ARG TAILSCALE_SHA256_AMD64=50748df1045e60b5b695f19f4c56b0da36c019948b440fb456b6584a50f0d8b9
ARG TAILSCALE_SHA256_ARM64=9dd1e6a592a014bbaea0103167ffe299adeda4ba14e078ce9c2895364f6c4c3f
RUN ARCH=$(dpkg --print-architecture) \
    && if [ "$ARCH" = "arm64" ]; then TAILSCALE_ARCH="arm64"; TAILSCALE_SHA256="$TAILSCALE_SHA256_ARM64"; else TAILSCALE_ARCH="amd64"; TAILSCALE_SHA256="$TAILSCALE_SHA256_AMD64"; fi \
    && curl -fSL "https://pkgs.tailscale.com/stable/tailscale_${TAILSCALE_VERSION}_${TAILSCALE_ARCH}.tgz" \
        -o /tmp/tailscale.tgz \
    && echo "${TAILSCALE_SHA256}  /tmp/tailscale.tgz" | sha256sum -c - \
    && mkdir -p /tmp/tailscale-extract \
    && tar -xzf /tmp/tailscale.tgz -C /tmp/tailscale-extract --strip-components=1 \
    && mv /tmp/tailscale-extract/tailscaled /usr/local/bin/tailscaled \
    && mv /tmp/tailscale-extract/tailscale /usr/local/bin/tailscale \
    && rm -rf /tmp/tailscale.tgz /tmp/tailscale-extract \
    && tailscaled --version \
    && tailscale version

# Apply starship/eza/bat to every interactive bash session. Debian/Ubuntu bash
# sources /etc/bash.bashrc even when invoked with --rcfile (verified against
# a real container) — unlike /etc/profile.d/*.sh, which only runs for LOGIN
# shells and would never fire for the agent's real terminal session (bash
# --rcfile <tmp>/.bashrc, see terminal-session.ts).
COPY docker/bashrc-extra.sh /tmp/bashrc-extra.sh
RUN cat /tmp/bashrc-extra.sh >> /etc/bash.bashrc && rm /tmp/bashrc-extra.sh

# MSSQL tools (amd64 only — kept separate due to conditional apt-get)
# Microsoft's Ubuntu 26.04 ("resolute") repository is signed with the 2025
# key (microsoft-2025.asc); the older microsoft.asc fails with
# NO_PUBKEY EE4D7792F748182B. curl -f turns an HTTP error into a build
# failure instead of piping an error page into gpg.
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      curl -fsSL https://packages.microsoft.com/keys/microsoft-2025.asc | gpg --dearmor > /usr/share/keyrings/microsoft.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/ubuntu/26.04/prod resolute main" \
          > /etc/apt/sources.list.d/mssql-release.list \
      && (apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update)) \
      && ACCEPT_EULA=Y apt-get install -y --no-install-recommends mssql-tools18 unixodbc-dev \
      && rm -rf /var/lib/apt/lists/*; \
    fi
ENV PATH="$PATH:/opt/mssql-tools18/bin"

# GitHub CLI + GitLab CLI (combined into one layer)
# gh comes from GitHub's signed apt repository with full signature
# verification — there is deliberately no unauthenticated fall-back. (The
# Debian-based image re-installed debian-archive-keyring and, when apt output
# contained "invalid signature", installed gh with --allow-unauthenticated.
# That was dropped with the move to Ubuntu 26.04: the keyring refresh
# addressed Debian archive-key rotation, which does not apply to
# ubuntu-keyring; apt 3.2 no longer prints "At least one invalid signature
# was encountered" (it reports "OpenPGP signature verification failed: ...
# The following signatures were invalid: BADSIG ..."), so the probe could
# never fire; and a BADSIG is exactly what a tampered repository looks like,
# so it could not tell a broken builder from an attack.) A failed signature
# check now fails the build.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && (apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update)) \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/* \
    && ARCH=$(dpkg --print-architecture) \
    && GLAB_VERSION=$(curl -sL "https://gitlab.com/api/v4/projects/34675721/releases/permalink/latest" | sed -n 's/.*"tag_name":"v\([^"]*\)".*/\1/p') \
    && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${ARCH}.deb" \
        -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb \
    && gh --version \
    && glab --version

# code-server (VS Code Server) — kept separate; version tied to code-server releases
RUN curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix=/usr/local \
    && code-server --version

# =============================================================================
# Layer 4: Node.js global tools (stable — version-pinned)
# =============================================================================
RUN npm install -g \
    # Word (.docx) to HTML/markdown conversion
    mammoth@1 \
    # Excel (.xlsx) read/write (SheetJS community edition)
    xlsx@0.18 \
    # CSV parsing and generation
    csv-parse@5 csv-stringify@6 \
    # Markdown to HTML and vice versa
    marked@15 turndown@7 \
    && npm cache clean --force

# =============================================================================
# Layer 5: System dependencies for Playwright Chromium
# Browser binary itself is installed in Layer 6 with the playwright version
# that actually ships with @ai-support-agent/cli, to avoid Chromium revision
# mismatch (e.g. `Executable doesn't exist at .../chromium_headless_shell-XXXX`).
# This layer installs only the OS packages so the heavier work below can use
# `playwright install` without `--with-deps` (no apt-get on the runtime path).
# =============================================================================
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
# `playwright install-deps` shells out to apt-get, so it needs a package index.
# Layer 4 ends with `rm -rf /var/lib/apt/lists/*`, so without the refresh below
# this resolved against a wiped/skewed index: on arm64 the build failed with
# `xvfb : Depends: xserver-common (>= ...) but it is not going to be installed`
# / `held broken packages`. amd64 carried the same defect and only happened to
# succeed. Retry chain matches every other apt step in this file.
#
# The playwright used for install-deps is pinned (PLAYWRIGHT_DEPS_VERSION)
# instead of whatever `npx --yes playwright` resolves to on the day of the
# build: `install-deps` only knows the distributions its own release lists,
# and playwright 1.58-1.60 refuse ubuntu26.04 ("not supported") while 1.62+
# support it (verified). Keep it >= the floor of the "playwright" range in
# package.json (__tests__/docker/dockerfile-ubuntu-base.spec.ts checks this),
# so the OS libraries match the playwright that Layer 6 installs.
ARG PLAYWRIGHT_DEPS_VERSION=1.65.0
RUN (apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update)) \
    && npx --yes "playwright@${PLAYWRIGHT_DEPS_VERSION}" install-deps chromium \
    && rm -rf /var/lib/apt/lists/*

# =============================================================================
# Layer 6: Application packages (changes on every version bump)
# ARG placed here so layers above remain cached when AGENT_VERSION changes.
# =============================================================================
ARG AGENT_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code @openai/codex @ai-support-agent/cli@${AGENT_VERSION} \
    # backlog-mcp-server is installed separately with --ignore-scripts because
    # backlog-mcp-server@0.13.0 added a `preinstall: npx only-allow pnpm` guard
    # that aborts `npm install` (exit 254 / npx ENOENT in a fresh layer). The
    # guard is a footgun leaked from the maintainer's npm->pnpm dev-workflow
    # migration — nulab's own README still tells consumers to run it via
    # `npx backlog-mcp-server` (npm). For 0.13.0 the published package ships
    # pre-built with no needed install/postinstall scripts, so --ignore-scripts
    # skips only that harmless guard and the resulting binary works (verified).
    #
    # PINNED to an exact version so --ignore-scripts stays scoped to a release
    # we verified: an unpinned install would let a future version's
    # legitimately-needed lifecycle script (e.g. a native-binary download) be
    # silently skipped, shipping a broken binary with a green build. Bumping
    # this version is a deliberate step that must re-verify the guard/scripts.
    # The `--version` smoke check right after install turns any such broken /
    # incomplete install into a loud build failure instead of a silent one.
    # Kept on its own command so the packages above retain their lifecycle scripts.
    && npm install -g backlog-mcp-server@0.13.0 --ignore-scripts \
    && backlog-mcp-server --version \
    && npm cache clean --force

# Install playwright npm package as peer of @ai-support-agent/cli, then download
# the Chromium binary matching THIS playwright's expected revision.
# Doing the binary download *after* the peer install guarantees that the
# revision under /opt/playwright-browsers matches what playwright runtime
# resolves, fixing the "Executable doesn't exist at ..." error that occurred
# when `npx playwright install` (Layer 5) picked a newer playwright via npx
# cache than the one pinned by @ai-support-agent/cli's peer dep.
RUN cd /usr/local/lib/node_modules/@ai-support-agent/cli \
    && npm install playwright \
    && node node_modules/playwright/cli.js install chromium \
    && chmod -R 755 /opt/playwright-browsers

# =============================================================================
# Layer 7: Permissions and runtime setup (lightweight, changes rarely)
# =============================================================================

# Fix npm cache/global directory permissions for runtime user (may run as non-root)
# The npm cache and global lib are created as root during build; runtime updates need write access.
RUN chmod -R 777 /usr/local/lib/node_modules \
    && chmod -R 777 /usr/local/bin \
    && rm -rf /home/node/.npm \
    && mkdir -p /home/node/.npm /home/node/.codex \
    && chmod 777 /home/node /home/node/.npm /home/node/.codex

WORKDIR /workspace
RUN chmod 777 /workspace

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chmod a+w /etc/passwd

# System-wide tmux config (applies to every session regardless of the
# runtime UID entrypoint.sh assigns) — see docker/tmux.conf for the status
# bar styling.
COPY docker/tmux.conf /etc/tmux.conf

# System-wide starship config (STARSHIP_CONFIG above points here) — see
# docker/starship.toml for why the container module's default "dimmed"
# style is overridden.
COPY docker/starship.toml /etc/starship.toml

ENTRYPOINT ["/entrypoint.sh"]
