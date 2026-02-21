# AI Support Agent CLI

[![npm version](https://img.shields.io/npm/v/ai-support-agent.svg)](https://www.npmjs.com/package/ai-support-agent)
[![license](https://img.shields.io/npm/l/ai-support-agent.svg)](https://github.com/mbc-net/ai-support-agent-client/blob/main/LICENSE)

Multi-tenant AI support agent CLI that connects to your AI Support Agent server. It runs as a background agent on your machine, receiving and executing commands from the server while reporting results back in real time.

## Features

- **Multi-project support** - Manage multiple projects under different tenants from a single CLI
- **Browser-based OAuth authentication** - Secure login via Cognito with automatic browser redirect
- **Remote command execution** - Execute shell commands, read/write files, and manage processes
- **Heartbeat monitoring** - Automatic health reporting to the server
- **i18n support** - English (default) and Japanese locales with OS locale auto-detection

## Quick Start

```bash
# Install globally
npm install -g ai-support-agent

# Login via browser OAuth
ai-support-agent login --url https://your-web-ui.example.com

# Start the agent
ai-support-agent start
```

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start the agent and begin polling for commands |
| `login` | Authenticate with the server via browser-based OAuth |
| `add-project` | Add a project to the agent configuration |
| `remove-project` | Remove a project from the agent configuration |
| `configure` | Update agent configuration interactively |
| `set-language` | Set the display language (`en` or `ja`) |
| `status` | Show current agent status and configuration |

### Start

```bash
# Start with default settings
ai-support-agent start

# Start with verbose logging
ai-support-agent start --verbose

# Start with a specific project
ai-support-agent start --project my_project
```

### Login

```bash
# Login via browser OAuth
ai-support-agent login --url https://your-web-ui.example.com

# Login with explicit API URL
ai-support-agent login --url https://your-web-ui.example.com --api-url https://api.example.com
```

### Project Management

```bash
# Add another project via browser OAuth
ai-support-agent add-project --url https://your-web-ui.example.com

# Remove a project by code
ai-support-agent remove-project my_project

# Manual token setup (backward compatible)
ai-support-agent configure --token <token> --api-url <url> --project-code my_project
```

## Configuration File

The agent stores its configuration at `~/.ai-support-agent/config.json`:

```json
{
  "agentId": "hostname-a1b2",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "lastConnected": "2025-01-01T12:00:00.000Z",
  "language": "en",
  "projects": [
    {
      "projectCode": "my_project",
      "token": "agt_...",
      "apiUrl": "https://api.example.com"
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `agentId` | Auto-generated unique agent identifier (hostname + random hex) |
| `createdAt` | Timestamp when the config was first created |
| `lastConnected` | Timestamp of last successful connection |
| `language` | Display language (`en` or `ja`) |
| `projects` | Array of registered projects with `projectCode`, `token`, and `apiUrl` |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_SUPPORT_AGENT_API_URL` | Override the server URL from config |
| `AI_SUPPORT_AGENT_TOKEN` | Override the auth token from config |

Environment variables have the lowest priority (CLI args > config file > env vars).

## Language / i18n

The CLI supports English and Japanese. Language is determined in the following order:

1. `--lang` flag on any command (e.g., `ai-support-agent start --lang ja`)
2. Value set via `ai-support-agent set-language <lang>`
3. Auto-detection from OS locale (`LANG`, `LC_ALL`, or `LC_MESSAGES`)
4. Default: `en`

```bash
# Set language to Japanese
ai-support-agent set-language ja

# Run a single command in Japanese
ai-support-agent status --lang ja
```

## Security

- **Config file permissions**: The configuration file is created with mode `0o600` (owner read/write only)
- **Localhost-only auth server**: The OAuth callback server binds to `127.0.0.1` and shuts down immediately after receiving the callback
- **CSRF nonce protection**: Each login flow generates a unique nonce to prevent cross-site request forgery

## Development

```bash
# Clone the repository
git clone https://github.com/mbc-net/ai-support-agent-client.git
cd ai-support-agent-client

# Install dependencies
npm install

# Run in development mode
npm run dev -- start --verbose

# Run tests
npm test

# Run tests with coverage
npm run test:cov
```

## License

[MIT](LICENSE)
