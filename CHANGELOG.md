# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-02-22

### Added
- Initial public release
- Multi-project support with `login`, `add-project`, `remove-project` commands
- Browser-based OAuth authentication
- Agent heartbeat and command polling
- Command execution (shell, file read/write/list, process management)
- i18n support (English default, Japanese locale)
- Environment variable support (`AI_SUPPORT_AGENT_API_URL`, `AI_SUPPORT_AGENT_TOKEN`)
- Configuration management with `~/.ai-support-agent/config.json`
