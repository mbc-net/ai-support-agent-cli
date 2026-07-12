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
    default-mysql-client postgresql-client \
    gnupg apt-transport-https \
    # Build tools for native addons (node-pty)
    make g++ \
    # Network diagnostic tools (for server troubleshooting)
    iputils-ping net-tools dnsutils whois traceroute netcat-openbsd iproute2 \
    # Terminal multiplexer (auto-attached for each agent console session)
    tmux \
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
    # Server setup execution: runs agent/ansible/playbook.yml against target hosts.
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
# Version ranges pinned for the same reproducibility reason as ansible-core
# above — an unbounded install could silently pick up a future major release
# with a changed module interface (e.g. mysql_user/postgresql_user parameter
# shape) that ansible/roles/database/tasks/main.yml wasn't validated against.
# Installed to /usr/share/ansible/collections — one of ansible-core's default
# collection search paths regardless of the runtime user's $HOME — so the
# collections are found no matter which UID the container ultimately runs as
# (see docker/entrypoint.sh's dynamic passwd-entry handling for --user).
RUN ansible-galaxy collection install \
    'ansible.mysql:>=5.0.0,<6.0.0' \
    'community.postgresql:>=4.0.0,<5.0.0' \
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
RUN (apt-get update --allow-insecure-repositories -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false \
        || (sleep 5 && apt-get update --allow-insecure-repositories -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false) \
        || (sleep 15 && apt-get update --allow-insecure-repositories -o Acquire::Check-Valid-Until=false -o Acquire::Check-Date=false) \
        || true) \
    && apt-get install -y --allow-unauthenticated debian-archive-keyring \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
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
    && rm /tmp/glab.deb

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
RUN npm install -g @anthropic-ai/claude-code @openai/codex @ai-support-agent/cli@${AGENT_VERSION} backlog-mcp-server \
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

ENTRYPOINT ["/entrypoint.sh"]
