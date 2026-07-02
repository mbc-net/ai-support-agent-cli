---
description: Update documentation (README, API specs, CLAUDE.md, etc.) to keep it in sync with code changes. Detects and fixes drift between implementation and docs.
argument-hint: "[target document | leave empty to auto-detect drift]"
---

# /update-docs command

**Input**: $ARGUMENTS

A command that detects drift between the implementation and its documentation, and updates the documentation to match reality.

## Behavior

### 1. Identify the target

- If `$ARGUMENTS` specifies a document, target that.
- If empty, infer which documents are affected from recent changes (`git diff HEAD~10 --name-only`, or uncommitted changes):

| Change | Documents to check |
|---|---|
| API endpoints/DTOs | API spec, OpenAPI definitions, README's API section |
| Public function signature changes | Function reference on the docs site (see the consistency check below) |
| Tests added/changed | describe/it spec descriptions (see the test-description check below) |
| Environment variables/config | README's setup section, `.env.example` |
| CLI commands/scripts | README's usage section, `package.json` scripts descriptions |
| DB schema | ER diagram/schema docs, migration instructions |
| Architecture/conventions | CLAUDE.md, ADRs, CONTRIBUTING |

### 2. Detect drift

Cross-check the documentation against the implementation and look for:

- References to files, commands, or endpoints that no longer exist
- Steps, parameters, or default values that differ from the implementation
- Added features/settings with no documentation
- Documentation for features that have since been removed

### 3. Update

- **Prioritize fixing factual errors** (wrong instructions do more harm than a missing mention of a new feature).
- Match the existing documentation's tone, structure, and language.
- For docs auto-generated from code (OpenAPI, etc.), suggest re-running the generation command rather than hand-editing.
- For anything you're not confident about (design rationale that isn't clear from the code, etc.), don't rewrite it blindly — list it as an open question instead.

### 4. Docs-site consistency check (only for projects with a docs site)

If a Docusaurus (or similar) docs-site directory exists, do the following.
For detailed build/generation pipeline patterns, see the docs-site skill.

1. **Cross-check hand-written function reference pages**
   - Grep for pages whose frontmatter has a `source: <path>#<functionName>` key.
   - For each such page, read the implementation at `source` and verify:
     - **Errors**: function name, parameter names, required/optional status, or thrown exceptions that don't match the implementation
     - **Missing coverage**: parameters or exceptions that exist in the implementation but aren't in the page's parameter table or error section
     - **Stale content**: anything documented on the page that's been removed from the implementation
   - Always correct the documentation **to match the implementation**. If the implementation itself looks wrong, don't fix it — add it to the open-questions list instead.
   - List any hand-written reference page without a `source` key as "not checkable" and suggest adding the key.
2. **Auto-generated pages (OpenAPI/TypeDoc)**
   - Don't edit generated pages directly — suggest re-running the generation command (`openapi:generate`, etc.).
   - Regenerate the committed `openapi.json` and diff it to catch decorator changes that weren't reflected.
3. **Verify test links**
   - For links to tests within reference pages, confirm the linked file actually exists in the repository.
4. **i18n translation freshness**
   - For hand-written pages that exist in multiple locales, compare git's last-modified timestamps and flag any translation older than its source as "needs review."

### 5. Detect drift in test descriptions

- Detect mismatches between what a describe/it name claims and what the body actually asserts
  (e.g., named "throws an exception" but never checks for one; named "gets persisted" but never reads back from the DB).
- Suggest renaming uninformative names ("happy path," "test1," etc.) only when a change already touches that test.

### 6. Report

```
## Documentation update

Files updated:
- <file>: <summary of the fix>

### Consistency check results (docs site)
- Errors: <page:item> — <discrepancy with the implementation> (fixed/needs review)
- Missing coverage: <page> — <item present in the implementation but undocumented>
- Stale content: <page> — <documented item removed from the implementation>
- Broken links: <page> — <nonexistent test file>
- Stale translations: <page> — <source update date vs. translation update date>

### Test descriptions
- <test file:test name> — <mismatch between the name and the assertions>

Detected but not fixed (needs review):
- <file:section> — <reason (unclear intent, needs a judgment call)>
```

## Notes

- Only create new documentation when explicitly requested — the primary job here is fixing drift.
- Don't mechanically generate a CHANGELOG from commit history; keep it focused on user-facing changes.
- When updating CLAUDE.md, keep it concise — it gets loaded into every session, so bulk has a real cost.
