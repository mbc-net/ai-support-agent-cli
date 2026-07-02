# Sync notes: mbc-claude-code -> ai-support-agent plugin

Source repository: https://github.com/mbc-net/mbc-claude-code
Source commit: 3f94f4aa9ab03f6cc1d132f478be71a0b99d123c (v1.9.0)
Ported on: 2026-07-01

This document tracks how each file in this plugin maps back to its origin in
`mbc-net/mbc-claude-code`, so future updates to the source repository can be
reviewed and ported deliberately rather than through a fully automated sync.

## Excluded from this port

| Source path | Reason |
| --- | --- |
| `commands/support.md` | Depends on MBC-internal MCP tools (Backlog/Slack/Notion/Sentry integrations) |
| `rules/mbc-cqrs-serverless/coding-rules.md` | Specific to a proprietary internal framework |

## Mapping table

| Source | Target | Status | Notes |
| --- | --- | --- | --- |
| `agents/planner.md` | `agents/planner.md` | translated | |
| `agents/code-reviewer.md` | `agents/code-reviewer.md` | translated | |
| `agents/typescript-reviewer.md` | `agents/typescript-reviewer.md` | translated | |
| `agents/python-reviewer.md` | `agents/python-reviewer.md` | translated | |
| `agents/php-reviewer.md` | `agents/php-reviewer.md` | translated | |
| `agents/react-reviewer.md` | `agents/react-reviewer.md` | translated | |
| `agents/nextjs-reviewer.md` | `agents/nextjs-reviewer.md` | translated | |
| `agents/django-reviewer.md` | `agents/django-reviewer.md` | translated | |
| `agents/ui-reviewer.md` | `agents/ui-reviewer.md` | translated | |
| `agents/infra-reviewer.md` | `agents/infra-reviewer.md` | translated | |
| `agents/silent-failure-hunter.md` | `agents/silent-failure-hunter.md` | translated | |
| `agents/investigator.md` | `agents/investigator.md` | translated | |
| `agents/build-error-resolver.md` | `agents/build-error-resolver.md` | translated | |
| `commands/plan.md` | `commands/plan.md` | translated | |
| `commands/code-review.md` | `commands/code-review.md` | translated | |
| `commands/add-feature.md` | `commands/add-feature.md` | translated | |
| `commands/fix-defect.md` | `commands/fix-defect.md` | translated | |
| `commands/build-fix.md` | `commands/build-fix.md` | translated | |
| `commands/test-coverage.md` | `commands/test-coverage.md` | translated | |
| `commands/update-docs.md` | `commands/update-docs.md` | translated | |
| `commands/learn.md` | `commands/learn.md` | translated | |
| `commands/learn-eval.md` | `commands/learn-eval.md` | translated | |
| `commands/support.md` | -- | excluded | Depends on MBC-internal MCP tools (Backlog/Slack/Notion/Sentry) |
| `skills/api-design/SKILL.md` | `skills/api-design/SKILL.md` | translated | |
| `skills/backend-patterns/SKILL.md` | `skills/backend-patterns/SKILL.md` | translated | |
| `skills/database-migrations/SKILL.md` | `skills/database-migrations/SKILL.md` | translated | |
| `skills/docker-patterns/SKILL.md` | `skills/docker-patterns/SKILL.md` | translated | |
| `skills/docs-site/SKILL.md` | `skills/docs-site/SKILL.md` | translated | |
| `skills/e2e-testing/SKILL.md` | `skills/e2e-testing/SKILL.md` | translated | |
| `skills/frontend-patterns/SKILL.md` | `skills/frontend-patterns/SKILL.md` | translated | |
| `skills/integration-testing/SKILL.md` | `skills/integration-testing/SKILL.md` | translated | |
| `rules/common/coding-guidelines.md` | `rules/common/coding-guidelines.md` | translated | |
| `rules/documentation/api-docs.md` | `rules/documentation/api-docs.md` | translated | |
| `rules/documentation/docs-site.md` | `rules/documentation/docs-site.md` | translated | |
| `rules/documentation/source-docs.md` | `rules/documentation/source-docs.md` | translated | |
| `rules/documentation/test-docs.md` | `rules/documentation/test-docs.md` | translated | |
| `rules/logging/logging-rules.md` | `rules/logging/logging-rules.md` | translated | |
| `rules/php/coding-rules.md` | `rules/php/coding-rules.md` | translated | |
| `rules/python/coding-rules.md` | `rules/python/coding-rules.md` | translated | |
| `rules/typescript/coding-rules.md` | `rules/typescript/coding-rules.md` | translated | |
| `rules/mbc-cqrs-serverless/coding-rules.md` | -- | excluded | Specific to a proprietary internal framework |
| `hooks/hooks.json` | `hooks/hooks.json` | translated | Structure unchanged; no user-facing strings to translate |
| `hooks/scripts/guard-dangerous-commands.sh` | `hooks/scripts/guard-dangerous-commands.sh` | translated | Logic, conditions, and fail-open behavior preserved; comments/messages translated to English |
| `hooks/scripts/check-secrets-before-commit.sh` | `hooks/scripts/check-secrets-before-commit.sh` | translated | Logic, conditions, and fail-open behavior preserved; comments/messages translated to English |
| `hooks/scripts/protect-sensitive-files.sh` | `hooks/scripts/protect-sensitive-files.sh` | translated | Logic, conditions, and fail-open behavior preserved; comments/messages translated to English |
| `hooks/scripts/auto-format.sh` | `hooks/scripts/auto-format.sh` | translated | Logic, conditions, and fail-open behavior preserved; comments/messages translated to English |

## ai-support-agent-specific additions (not from upstream)

The following were authored directly in this plugin and have no counterpart in
`mbc-net/mbc-claude-code`. They compensate for a gap specific to how this
plugin is invoked here: `claude -p` (non-interactive) restarts as a fresh
process every turn, so from turn 2 onward a command's `.md` body is not
guaranteed to be re-expanded, which threatens the approval/commit gate
discipline that `/plan`, `/add-feature`, and `/fix-defect` rely on across
multiple turns.

| File | What it adds |
| --- | --- |
| `commands/plan.md`, `commands/add-feature.md`, `commands/fix-defect.md` | `resumable: true` frontmatter field; a "Completion Marker Convention" section describing the `<!-- ai-support-agent:resume name="<command>" -->` end-of-response marker; a `<!-- RESUME_DIGEST_START -->` / `<!-- RESUME_DIGEST_END -->` block distilling that command's must-obey constraints (gates, test-first, verification-evidence requirements) for reinjection on later turns |
| `hooks/scripts/on-command-stop.sh` | New `Stop` hook. Reads the transcript, detects the completion marker in the last assistant message (excluding matches inside fenced code blocks), and writes/increments/deletes a per-conversation state file under `~/.ai-support-agent/plugin-resume/`. Also opportunistically prunes state files older than 24h |
| `hooks/scripts/on-command-resume.sh` | New `UserPromptSubmit` hook. If a state file exists for the current conversation and is within the turn-count safety valve, extracts the originating command's Resume Digest and emits it as `hookSpecificOutput.additionalContext` so the model sees it again without the full command body being re-expanded |
| `hooks/hooks.json` | New `UserPromptSubmit` and `Stop` top-level entries registering the two scripts above. The existing `PreToolUse`/`PostToolUse` entries are unmodified upstream ports (see the mapping table) |

These additions are maintained independently of the upstream sync process
described below — they are not expected to have an upstream equivalent to
diff against.

## Keeping this port up to date

There is no fully automated sync script by design -- changes to
mbc-claude-code should be reviewed and ported deliberately, since this port
also translates and generalizes content (removing MBC-internal references).

To check what has changed upstream since this port, run:

```bash
git -C <path to a clone of mbc-net/mbc-claude-code> log --oneline \
  3f94f4aa9ab03f6cc1d132f478be71a0b99d123c..HEAD -- <source path>
```

For example, to check for updates to the hooks:

```bash
git -C <path to a clone of mbc-net/mbc-claude-code> log --oneline \
  3f94f4aa9ab03f6cc1d132f478be71a0b99d123c..HEAD -- hooks/
```

Review each changed source file, apply the equivalent change to the
corresponding target file in this plugin (translating and generalizing as
needed), and update the "Source commit" line above along with the relevant
row(s) in the mapping table.
