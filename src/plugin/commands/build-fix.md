---
description: Fix build and type errors with the smallest possible diff to get the build green. Does not refactor or add features.
argument-hint: "[error message | leave empty to auto-diagnose]"
---

# /build-fix command

**Input**: $ARGUMENTS

A command for getting a broken build back to green with the smallest possible change. This command is a thin entry point. Detecting the project type and deciding how to diagnose and fix it is delegated to the `build-error-resolver` subagent (bundled with this plugin) as a rule.

## Behavior

### 1. Handling the input

- If `$ARGUMENTS` contains an error message, use it as the starting point for the fix.
- If empty, start from auto-diagnosis. Detecting the project type, choosing diagnostic commands, and the discipline of minimal fixes are delegated to build-error-resolver.
- In a monorepo, scope the work to only the workspaces that changed.

### 2. Error-classification priority (overview)

1. **Build-breaking** (compilation failures, module resolution failures) — highest priority
2. **Type errors** — next
3. **Lint warnings, deprecated APIs** — only if time allows

### 3. Completion report

```
## Build fix complete

Before: <n> errors → After: 0 errors
Changed files: <list>
Lines changed: <n>

Key fixes:
- <file:line> <one-line description of the fix>

Verification:
- <diagnostic command run>: Pass
- Tests (if run): Pass / Warning (details)
```

## Notes

- **Always confirm with the user before any destructive recovery** (clearing caches, rebuilding `node_modules`, etc.) before running it.
- If the same error survives 5 fix attempts, present a hypothesis and options and let the user decide (don't loop indefinitely).
- If the fix turns out to require an architectural change, stop and suggest switching to `/plan`.
