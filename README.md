# AI Support Agent CLI

[![npm version](https://img.shields.io/npm/v/@ai-support-agent/cli.svg)](https://www.npmjs.com/package/@ai-support-agent/cli)
[![license](https://img.shields.io/npm/l/@ai-support-agent/cli.svg)](https://github.com/mbc-net/ai-support-agent-cli/blob/main/LICENSE)

A daemon that turns your machine into an AI-powered remote agent. Install it, authenticate via browser, and your team can send shell commands, AI chat prompts, file operations, and more — all from a Web UI, with results streamed back in real time.

```
┌──────────────┐  AppSync     ┌─────────────────┐  WebSocket/HTTP  ┌──────────────────┐
│   Web UI     │ ──────────── │   API Server    │ ─────────────── │  Agent CLI       │
│  (browser)   │  subscription│   (NestJS)      │  commands/result │  (your machine)  │
└──────────────┘              └─────────────────┘                  └──────────────────┘
                                                                     ├─ Claude Code
                                                                     ├─ Shell / PTY
                                                                     ├─ File I/O
                                                                     ├─ Git repos
                                                                     ├─ MCP server
                                                                     └─ VS Code tunnel
```

## Why?

- **Remote AI pair-programming** — Ask questions about your codebase from the Web UI; Claude Code runs on the agent machine with full repository access.
- **Multi-tenant, multi-project** — A single agent manages multiple projects across different tenants. Add/remove projects on the fly; the agent hot-reloads.
- **Zero-config realtime** — AppSync WebSocket subscriptions deliver commands instantly. No polling delay, no port forwarding.
- **Secure by default** — OAuth login, 0600 config permissions, nonce-protected callbacks, SQL injection detection, path traversal guards, and environment sanitization.

## Quick Start

```bash
npm install -g @ai-support-agent/cli

# Opens your browser → select tenant & project → done
ai-support-agent login

# Start the daemon (Ctrl-C to stop)
ai-support-agent start
```

That's it. The agent registers with the server, syncs project config, clones repositories, and starts listening for commands.

### Add more projects

```bash
ai-support-agent add-project          # browser OAuth flow
ai-support-agent status               # verify registered projects
```

### Run in Docker

```bash
ai-support-agent start --docker
```

Project dirs, `~/.claude/`, and `~/.aws/` are auto-mounted. The container runs with your host UID/GID.

### Run as a background service

```bash
ai-support-agent service install      # install as a system service
ai-support-agent service start        # start the service
ai-support-agent service status       # check service status
ai-support-agent service stop         # stop the service
ai-support-agent service restart      # restart the service
ai-support-agent service uninstall    # remove the service
```

## How It Works

1. **Register** — Agent sends its capabilities (shell, file I/O, chat, terminal, vscode) to the API.
2. **Subscribe** — Connects to AppSync for real-time command delivery.
3. **Config sync** — Pulls project settings, MCP config, and repo list from the server.
4. **Execute** — Receives commands, runs them locally, streams results back chunk-by-chunk.

Each project runs in its own forked child process. The main process watches `config.json` and hot-adds/removes projects without restart.

### Supported Commands

| Command Type | What It Does |
|-------------|-------------|
| `chat` | Runs Claude Code (or Anthropic API) with your codebase context |
| `execute_command` | Executes a shell command with timeout and output capture |
| `file_read` / `file_write` / `file_list` / `file_rename` / `file_delete` / `file_mkdir` | File system operations |
| `process_list` / `process_kill` | Process management |
| `chat_cancel` | Cancels a running chat process |
| `e2e_test` | End-to-end test execution with Playwright browser automation and step reporting |
| `setup` / `config_sync` / `reboot` / `update` | Lifecycle management |

### Chat Modes

| Mode | How it works |
|------|-------------|
| `claude_code` (default) | Spawns Claude Code CLI as a subprocess with MCP tools, system prompts, and tool allowlists |
| `api` | Direct Anthropic API streaming. Requires `ANTHROPIC_API_KEY` |

The mode is resolved as: agent config → server default → auto-detection (whether `claude` CLI is installed).

### Built-in MCP Server

The agent ships a [Model Context Protocol](https://modelcontextprotocol.io/) server that Claude Code can call:

**General tools:**

| Tool | Description |
|------|-------------|
| `get_credentials` | Fetch AWS STS or database credentials from the API |
| `db_query` | Run SELECT queries (injection-protected) |
| `get_db_schemas` | Retrieve table/column metadata |
| `file_upload` | Upload files to S3 via presigned URLs |
| `get_project_info` | Fetch project configuration |
| `read_conversation_file` | Read conversation history |

**Browser automation tools (Playwright-based):**

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL and take a screenshot |
| `browser_click` | Click an element by CSS selector |
| `browser_fill` | Fill a form field with a value |
| `browser_get_text` | Extract text from a specific element |
| `browser_login` | Log in using saved credentials |
| `browser_extract` | Extract text and save to a session variable atomically |
| `browser_set_variable` / `browser_get_variable` / `browser_list_variables` | Manage session variables |
| `browser_close` | Close the browser session |

**E2E test tools:**

| Tool | Description |
|------|-------------|
| `report_test_step` | Report an E2E test step result (status, screenshot, duration) to the API |

## CLI Reference

```
ai-support-agent <command> [options]

Commands:
  start              Start the agent daemon
  login              Authenticate via browser OAuth
  add-project        Add a project (browser OAuth)
  remove-project     Remove a project by code
  configure          Register with --token and --api-url
  status             Show agent status and registered projects
  set-language       Set display language (en | ja)
  set-auto-update    Configure auto-update (--enable | --disable | --channel)
  set-project-dir    Set project working directory
  docker-login       Login and start in Docker
  service            Manage agent background service

Global options:
  --lang <lang>      Override display language for this invocation
  --version          Show version
```

### `service` Subcommands

```
service install     Install the agent as a system background service
service uninstall   Uninstall the agent service
service start       Start the agent service
service stop        Stop the agent service
service restart     Restart the agent service
service status      Show service status

Options (install):
  --verbose          Show detailed installation info
  --no-docker        Install in native mode (skip Docker)
```

### `start` Options

```
--verbose                  Enable debug logging
--heartbeat-interval <ms>  Heartbeat interval (default: 60000)
--no-auto-update           Disable auto-update for this session
--update-channel <channel> Release channel: latest | beta | alpha
--no-docker                Force native mode (skip Docker)
--docker                   Run inside a Docker container
```

### `set-project-dir` Options

```
--default <template>       Set default dir template (e.g. ~/projects/{projectCode})
--project <code> --path <path>  Set dir for a specific project
```

## Configuration

Stored at `~/.ai-support-agent/config.json` (mode `0600`):

```jsonc
{
  "agentId": "macbook-a1b2c3d4",       // auto-generated
  "createdAt": "2025-01-01T00:00:00Z",
  "lastConnected": "2025-06-15T09:00:00Z",
  "language": "en",                     // en | ja
  "agentChatMode": "claude_code",       // claude_code | api
  "defaultProjectDir": "~/.ai-support-agent/projects/{projectCode}",
  "autoUpdate": {
    "enabled": true,
    "autoRestart": true,
    "channel": "latest"                 // latest | beta | alpha
  },
  "projects": [
    {
      "projectCode": "MY_PROJECT",
      "token": "agt_xxxx",
      "apiUrl": "https://api.example.com",
      "projectDir": "~/custom-path"     // optional override
    }
  ]
}
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_SUPPORT_AGENT_TOKEN` | Override auth token (lowest priority) |
| `AI_SUPPORT_AGENT_API_URL` | Override API URL (lowest priority) |
| `AI_SUPPORT_AGENT_CONFIG_DIR` | Override config directory path |
| `ANTHROPIC_API_KEY` | Required for `api` chat mode |
| `AI_SUPPORT_E2E_EXECUTION_ID` | E2E test execution ID (set automatically during `e2e_test` runs) |
| `AI_SUPPORT_E2E_TEST_CASE_ID` | E2E test case ID (set automatically during `e2e_test` runs) |

Priority: CLI flags > config file > environment variables.

## Project Directory Structure

Each project gets an isolated workspace:

```
{projectDir}/
├── workspace/
│   ├── repos/          # Git-cloned repositories
│   ├── docs/           # Documentation from server
│   └── artifacts/      # Generated outputs
├── uploads/            # File uploads staging
└── .ai-support-agent/
    ├── cache/          # Temporary cache
    └── aws/            # AWS credential cache
```

## Security

| Layer | Detail |
|-------|--------|
| Authentication | Browser-based OAuth with localhost callback, CSRF nonce |
| Config file | Mode `0600`, directory `0700` |
| Path traversal | Blocked paths: `/root`, `/etc`, `/sys`, `/proc`, `/dev`, `~/.ssh`, `~/.aws`, etc. |
| SQL injection | Pattern-based detection: comments, time-based blind, encoding bypass, file system access |
| Subprocess env | Sensitive variables stripped before spawning child processes |
| File transfer | Extension allowlist (53 types), `basename()` sanitization |
| Git operations | Branch name validation to prevent CLI injection |

## Development

```bash
git clone https://github.com/mbc-net/ai-support-agent-cli.git
cd ai-support-agent-cli

npm install
npm run dev -- start --verbose    # development mode
npm test                          # run tests
npm run test:cov                  # coverage (95%+ thresholds enforced)
npm run build                     # compile to dist/
```

Requires Node.js >= 20. `node-pty` is an optional dependency for terminal/PTY sessions.

## License

[MIT](LICENSE)
