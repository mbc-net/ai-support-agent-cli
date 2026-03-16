FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git openssh-client vim \
    default-mysql-client postgresql-client \
    gnupg apt-transport-https \
    # Build tools for native addons (node-pty)
    make g++ \
    # Python 3 + pip (for document processing tools and node-gyp)
    python3 python3-pip python3-venv \
    # Pandoc (universal document converter: docx/pdf/html/markdown/etc.)
    pandoc \
    # PDF rendering support for Python PDF libraries
    libpoppler-cpp-dev poppler-utils \
    # Locale support (for Japanese filenames etc.)
    locales \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Python document processing tools (installed in system scope, no venv needed in container)
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
    chardet==5.*

# Node.js document processing tools (global)
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

# AWS CLI v2
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscliv2.zip \
    && unzip /tmp/awscliv2.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscliv2.zip

# AWS Session Manager Plugin
RUN ARCH=$(dpkg --print-architecture) \
    && curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_${ARCH}/session-manager-plugin.deb" \
        -o /tmp/session-manager-plugin.deb \
    && dpkg -i /tmp/session-manager-plugin.deb \
    && rm /tmp/session-manager-plugin.deb

# MSSQL tools (amd64 only)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then \
      curl https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor > /usr/share/keyrings/microsoft.gpg \
      && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/debian/12/prod bookworm main" \
          > /etc/apt/sources.list.d/mssql-release.list \
      && apt-get update \
      && ACCEPT_EULA=Y apt-get install -y --no-install-recommends mssql-tools18 unixodbc-dev \
      && rm -rf /var/lib/apt/lists/*; \
    fi
ENV PATH="$PATH:/opt/mssql-tools18/bin"

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# GitLab CLI
RUN ARCH=$(dpkg --print-architecture) \
    && GLAB_VERSION=$(curl -sL "https://gitlab.com/api/v4/projects/34675721/releases/permalink/latest" | sed -n 's/.*"tag_name":"v\([^"]*\)".*/\1/p') \
    && curl -fsSL "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_${ARCH}.deb" \
        -o /tmp/glab.deb \
    && dpkg -i /tmp/glab.deb \
    && rm /tmp/glab.deb

# code-server (VS Code Server)
RUN curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone --prefix=/usr/local \
    && code-server --version

# Claude Code CLI + AI Support Agent CLI + Backlog MCP Server
ARG AGENT_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code @ai-support-agent/cli@${AGENT_VERSION} backlog-mcp-server \
    && npm cache clean --force

WORKDIR /workspace
RUN chmod 777 /workspace

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chmod a+w /etc/passwd

ENTRYPOINT ["/entrypoint.sh"]
