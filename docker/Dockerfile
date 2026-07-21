FROM node:24-slim

# =============================================================================
# Layer 1: OS packages (most stable — rarely changes)
# =============================================================================
# Bust cache when Debian GPG signatures expire (bump this date to force full rebuild)
ARG APT_CACHE_BUST=2026-05-21
# `apt-get update` is retried (3 attempts, 5s/15s backoff) at every occurrence in
# this file to absorb transient DNS/network failures reaching deb.debian.org
# (e.g. Docker daemon DNS hiccups on Ubuntu 24.04+ hosts) that would otherwise
# abort the whole build on the first hit.
RUN (apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update)) \
    && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git openssh-client vim jq \
    # sshpass: Ansible's `ssh` connection plugin shells out to this for
    # ansible_ssh_pass (password-authType server_setup_exec hosts); without
    # it, ansible-playbook fails to authenticate against password-only hosts.
    sshpass \
    default-mysql-client postgresql-client \
    gnupg apt-transport-https \
    # Build tools for native addons (node-pty)
    make g++ \
    # Network diagnostic tools (for server troubleshooting)
    iputils-ping net-tools dnsutils whois traceroute netcat-openbsd iproute2 \
    # Terminal multiplexer (auto-attached for each agent console session)
    tmux \
    # fzf-lua (nvim plugin) shells out to this for fuzzy file/grep/buffer search
    fzf \
    # cat replacement with syntax highlighting (Debian ships the binary as
    # /usr/bin/batcat, not /usr/bin/bat, due to a package name clash)
    bat \
    # Python 3 + pip (for document processing tools and node-gyp)
    python3 python3-pip python3-venv \
    # Pandoc (universal document converter: docx/pdf/html/markdown/etc.)
    pandoc \
    # PDF rendering support for Python PDF libraries
    libpoppler-cpp-dev poppler-utils \
    # Locale support (for Japanese filenames etc.)
    locales \
    # Japanese fonts (for Playwright Chromium to render Japanese websites)
    fonts-noto-cjk \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen \
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
    beautifulsoup4==4.* lxml==5.* \
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
    'ansible-core>=2.16,<2.18'

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
# Installed to /usr/share/ansible/collections — one of ansible-core's default
# collection search paths regardless of the runtime user's $HOME — so the
# collections are found no matter which UID the container ultimately runs as
# (see docker/entrypoint.sh's dynamic passwd-entry handling for --user).
RUN ansible-galaxy collection install \
    'ansible.mysql:>=5.0.0,<6.0.0' \
    'community.postgresql:>=4.0.0,<5.0.0' \
    'ansible.posix:>=1.5.0,<2.0.0' \
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

# Neovim, built from source (pinned tag) — Debian bookworm's apt "neovim"
# package is 0.7.x, too old for the nvim-treesitter main-branch API
# (require("nvim-treesitter").install() / vim.treesitter.start()) used by
# docker/nvim/init.lua. A prebuilt release tarball was tried first and
# rejected: neovim's official arm64 release tarballs (v0.10.4+, the first to
# ship a separate arm64 asset) are linked against GLIBC >= 2.38, but this
# image's Debian bookworm base ships GLIBC 2.36 — the binary fails at
# container runtime with "version `GLIBC_2.38' not found" on arm64 hosts
# (verified against a real build; this affects local agent CLI runs on Apple
# Silicon Docker Desktop, not just ECS). Building from source links against
# whatever glibc this build stage actually has, so one Dockerfile path works
# on both amd64 and arm64 with no version-specific compatibility trap.
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
RUN git clone --depth 1 --branch "${NVIM_VERSION}" https://github.com/neovim/neovim /tmp/neovim-src \
    && cd /tmp/neovim-src \
    && make CMAKE_BUILD_TYPE=Release CMAKE_INSTALL_PREFIX=/opt/nvim install \
    && ln -s /opt/nvim/bin/nvim /usr/local/bin/nvim \
    && rm -rf /tmp/neovim-src \
    && nvim --version

# tree-sitter CLI — nvim-treesitter's parser install shells out to this to
# compile grammars (verified against a real build: without it, parser
# install fails with "Error during \"tree-sitter build\": ENOENT ...
# 'tree-sitter'"). Built from source via cargo: both the tree-sitter-cli npm
# package and tree-sitter/tree-sitter's own GitHub release arm64 binary are
# linked against GLIBC >= 2.39 (verified against a real build) — the same
# class of trap as neovim's prebuilt arm64 tarball above. rustc/cargo from
# apt (bookworm ships 1.63) are old enough that tree-sitter-cli may fail to
# build (MSRV), so rustup installs a toolchain first, mirroring this
# Dockerfile's other official-install-script tools (starship, code-server
# below). Both the toolchain and the crate are pinned to exact versions
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
# doesn't need network access on first use. XDG dirs point at /opt rather than
# $HOME: $HOME differs depending on whether the container runs as root (build
# time) or an arbitrary UID (entrypoint.sh's dynamic passwd-entry handling for
# --user), the same reasoning as /opt/playwright-browsers below.
ENV XDG_CONFIG_HOME=/opt/nvim-config
ENV XDG_DATA_HOME=/opt/nvim-data
ENV XDG_STATE_HOME=/opt/nvim-state
ENV XDG_CACHE_HOME=/opt/nvim-cache
RUN mkdir -p $XDG_CONFIG_HOME/nvim
COPY docker/nvim/init.lua $XDG_CONFIG_HOME/nvim/init.lua
RUN nvim --headless "+Lazy! sync" +qa \
    && nvim --headless -c "lua local missing={} for _,p in pairs(require('lazy').plugins()) do if not p._.installed then table.insert(missing,p.name) end end if #missing>0 then print('MISSING PLUGINS: '..table.concat(missing,', ')) vim.cmd('cquit 1') end" -c "qa" \
    && nvim --headless -c "lua require('nvim-treesitter').install({'markdown','markdown_inline'}):wait(300000)" -c "qa" \
    && nvim --headless -c "lua local installed={} for _,l in ipairs(require('nvim-treesitter.config').get_installed()) do installed[l]=true end if not (installed.markdown and installed.markdown_inline) then print('MISSING TREESITTER PARSERS') vim.cmd('cquit 1') end" -c "qa" \
    && chmod -R a+rwX $XDG_CONFIG_HOME $XDG_DATA_HOME $XDG_STATE_HOME $XDG_CACHE_HOME

# nvim をデフォルトエディタにする（git commit 等が $EDITOR/$VISUAL を参照する）
ENV EDITOR=nvim VISUAL=nvim

# starship prompt (pinned version — the install script's --version pins
# it to a verified release rather than tracking "latest" across rebuilds)
RUN curl -sS https://starship.rs/install.sh | sh -s -- --yes --version v1.26.0 \
    && starship --version
# 実行時UID（entrypoint.shが動的に割り当てる）に依存せず全セッションに
# 同じプロンプト設定を適用するため、$HOME/.config/starship.toml ではなく
# 固定パスをSTARSHIP_CONFIGで明示する（/etc/tmux.confと同じパターン）。
ENV STARSHIP_CONFIG=/etc/starship.toml

# eza (ls replacement with icons) — not packaged for Debian bookworm, so a
# dual-arch GitHub release binary is downloaded instead (verified against a
# real build: unlike neovim's arm64 tarball, eza's aarch64-unknown-linux-gnu
# release does NOT require a newer glibc than this image's bookworm base).
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

# Apply starship/eza/bat to every interactive bash session. Debian's bash
# sources /etc/bash.bashrc even when invoked with --rcfile (verified against
# a real container) — unlike /etc/profile.d/*.sh, which only runs for LOGIN
# shells and would never fire for the agent's real terminal session (bash
# --rcfile <tmp>/.bashrc, see terminal-session.ts).
COPY docker/bashrc-extra.sh /tmp/bashrc-extra.sh
RUN cat /tmp/bashrc-extra.sh >> /etc/bash.bashrc && rm /tmp/bashrc-extra.sh

# MSSQL tools (amd64 only — kept separate due to conditional apt-get)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      curl https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > /usr/share/keyrings/microsoft.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" \
          > /etc/apt/sources.list.d/mssql-release.list \
      && (apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update)) \
      && ACCEPT_EULA=Y apt-get install -y --no-install-recommends mssql-tools18 unixodbc-dev \
      && rm -rf /var/lib/apt/lists/*; \
    fi
ENV PATH="$PATH:/opt/mssql-tools18/bin"

# GitHub CLI + GitLab CLI (combined to reduce apt-get update calls)
# Re-install debian-archive-keyring to refresh GPG keys before apt-get update.
# This prevents "invalid signature" errors when this layer runs on a cached
# base where the Debian signing keys have been rotated since the cache was built.
# The SECOND apt-get update (right before installing gh) tries the strict path
# first; only if it fails AND apt reports the degraded-base symptom ("invalid
# signature" on every repo — a Docker Desktop cached-base gpgv failure) does it
# set DEGRADED and install gh with --allow-unauthenticated. Gating on that exact
# symptom keeps full signature verification on healthy hosts and for every other
# kind of failure (network, bad URL, a genuine tampered-package signature
# mismatch) — those still surface as a hard build failure instead of silently
# installing an unauthenticated package. Each fall-back path logs a WARNING to
# stderr, and `gh --version` / `glab --version` at the end turn a broken or
# missing binary into a loud build failure. Without this the build hard-failed
# with exit 100 on a degraded base (the first update above is already tolerant;
# leaving the second strict made the mitigation incomplete).
RUN (apt-get update --allow-insecure-repositories -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false \
        || (sleep 5 && apt-get update --allow-insecure-repositories -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false) \
        || (sleep 15 && apt-get update --allow-insecure-repositories -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false) \
        || true) \
    && apt-get install -y --allow-unauthenticated debian-archive-keyring \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && DEGRADED="" \
    && if apt-get update || (sleep 5 && apt-get update) || (sleep 15 && apt-get update); then \
           : ; \
       else \
           echo "WARNING: gh: strict package-list refresh failed; probing for degraded base GPG (invalid signature)" >&2 ; \
           UPD_OUT="$(apt-get update --allow-insecure-repositories -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false 2>&1)" ; \
           echo "$UPD_OUT" ; \
           if echo "$UPD_OUT" | grep -q "invalid signature"; then \
               echo "WARNING: gh: degraded base GPG detected; continuing in degraded (unauthenticated) mode" >&2 ; \
               DEGRADED=1 ; \
           fi ; \
       fi \
    && if [ -n "$DEGRADED" ]; then \
           apt-get install -y --no-install-recommends --allow-unauthenticated gh ; \
       else \
           apt-get install -y --no-install-recommends gh ; \
       fi \
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
RUN npx --yes playwright install-deps chromium

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
