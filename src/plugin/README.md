# ai-support-agent (Claude Code / Codex plugin)

A general-purpose toolkit of agents, commands, skills, and safety
hooks for AI-assisted software development. It is not tied to any specific
company or proprietary stack.

Based on and translated/generalized from
[mbc-net/mbc-claude-code](https://github.com/mbc-net/mbc-claude-code).

## What's included

### Agents (13)

- planner
- code-reviewer
- typescript-reviewer
- python-reviewer
- php-reviewer
- react-reviewer
- nextjs-reviewer
- django-reviewer
- ui-reviewer
- infra-reviewer
- silent-failure-hunter
- investigator
- build-error-resolver

### Commands (9)

- /plan
- /code-review
- /add-feature
- /fix-defect
- /build-fix
- /test-coverage
- /update-docs
- /learn
- /learn-eval

### Skills (8)

- api-design
- backend-patterns
- database-migrations
- docker-patterns
- docs-site
- e2e-testing
- frontend-patterns
- integration-testing

### Hooks (4)

- guard-dangerous-commands
- check-secrets-before-commit
- protect-sensitive-files
- auto-format

### Rules (9 files, referenced from your project's CLAUDE.md, not auto-loaded)

- common/coding-guidelines
- documentation/api-docs
- documentation/docs-site
- documentation/source-docs
- documentation/test-docs
- logging/logging-rules
- php/coding-rules
- python/coding-rules
- typescript/coding-rules

## How it's loaded

This plugin is automatically bundled by `ai-support-agent-cli`.

- Claude Code: the CLI passes this directory via `--plugin-dir` whenever it
  launches `claude`.
- Codex: the CLI materializes this directory as a local Codex marketplace under
  `CODEX_HOME` and launches `codex exec` with a bundled profile that enables it.

There is no separate installation step required for users of the CLI.

## What was intentionally excluded

The following mbc-claude-code components were intentionally excluded because
they depend on MBC-internal systems: the `/support` command (relies on
internal Backlog/Slack/Notion/Sentry MCP integrations) and the
`mbc-cqrs-serverless` coding rules (specific to a proprietary internal
framework).

## License

MIT. See [LICENSE](./LICENSE).
