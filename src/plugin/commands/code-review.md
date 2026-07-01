---
description: Run a code review across your stack and post a report and verdict to the PR/MR
argument-hint: "[PR/MR number or URL] (omit to review local uncommitted changes)"
---

# /code-review

This command lives in this plugin's namespace and is invoked as `/<plugin>:code-review` (which is distinct, by
namespace, from Claude Code's built-in `/code-review` and `/review` — an unprefixed `/code-review` may refer to
the built-in version). Where the built-in command does a general-purpose diff review, this command's added value
is applying review criteria specific to your stack (TypeScript / Python / PHP / React / Next.js / Vue / Django /
Laravel / CakePHP / IaC, etc.) and recording the review as a structured report that gets posted back. If a
general-purpose review is all you need, the built-in command works fine.

## Determining the mode

Check the `$ARGUMENTS` value to decide which mode to run in.

- No argument → Mode A (local review)
- A number (e.g. `123`) or a PR/MR URL → Mode B (PR/MR review)

## Selecting reviewers (both modes)

Look at the paths of the changed files and use the table below to decide which reviewers to run.
`code-reviewer` and `silent-failure-hunter` are always included.

| File-type condition | Reviewer to add |
|---|---|
| Includes `.ts` / `.tsx` / `.js` / `.jsx` / `.mjs` / `.cjs` | `typescript-reviewer` |
| `.tsx` / `.jsx` with component definitions | `react-reviewer` (alongside `typescript-reviewer`) |
| Touches `app/` / `pages/` / `next.config` / `middleware.ts` / a Server Action | `nextjs-reviewer` |
| Includes `.py` | `python-reviewer` |
| Touches Django-style files (`models.py` / `views.py` / `serializers.py` / `migrations/`, etc.) | `django-reviewer` (alongside `python-reviewer`) |
| Includes `.php` | `php-reviewer` |
| Touches UI components or layout | `ui-reviewer` |
| Includes `*.ts` (CDK) / `serverless.yml` / `template.yaml` / CloudFormation-style files | `infra-reviewer` |

This table matches the "delegating to other agents" routing table used by code-reviewer.
Treat the code-reviewer agent's routing table as the source of truth when adding or changing reviewers, and mirror the change here too.

## Workflow script (both modes)

Once the reviewer list is finalized, pass the script below to the Workflow tool's `script` parameter and run it in parallel.
Pass the selected reviewer names as `args.reviewers`, and the mode-specific review instructions (described below) as `args.reviewContext`.

```javascript
export const meta = {
  name: 'code-review-parallel',
  description: 'Run stack-specific reviewers in parallel to speed up code review',
  phases: [
    { title: 'Review' },
    { title: 'Merge' }
  ]
}

const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] },
          file: { type: 'string' },
          line: { type: 'string' },
          description: { type: 'string' },
          suggestion: { type: 'string' }
        },
        required: ['severity', 'description']
      }
    }
  },
  required: ['findings']
}

phase('Review')
const results = await parallel(args.reviewers.map(name => () =>
  agent(args.reviewContext, {
    label: name,
    phase: 'Review',
    agentType: name,
    schema: FINDINGS_SCHEMA
  })
))

phase('Merge')
const all = results.filter(Boolean).flatMap(r => r.findings || [])
const sorted = all.sort((a, b) =>
  (SEVERITY_ORDER[a.severity] ?? 4) - (SEVERITY_ORDER[b.severity] ?? 4)
)
return { findings: sorted }
```

Use the `findings` returned by the Workflow (already sorted by severity) in the steps that follow.

## Mode A: local review (no argument)

Review the uncommitted changes (both staged and unstaged).

1. Identify the changed files with `git diff HEAD --name-only` and select reviewers (see "Selecting reviewers" above).
2. Run the Workflow in parallel, passing the following as `args.reviewContext`:
   ```
   Review the current uncommitted changes (git diff HEAD, or the combination of git diff --staged and git diff).
   Read the full content of each changed file and its surrounding code (callers, type definitions, middleware,
   etc.) and report issues from your area of expertise. Don't judge from the diff alone.
   ```
3. Group the `findings` returned by the Workflow by severity (CRITICAL / HIGH / MEDIUM / LOW) and report them to the user.
   Don't post anything remotely in this mode.

## Mode B: PR/MR review (number or URL)

### Determining the host

Pick the CLI to use with the following rule.

- If the argument is a URL: use the `gh` CLI for `github.com`, the `glab` CLI for `gitlab.com`.
- If the argument is a bare number: check `git remote get-url origin` — use `gh` if it contains `github.com`, `glab` if it contains `gitlab.com`.
- For self-hosted setups that match neither, show the user the remote URL and ask which CLI to use.

### Steps

1. **Fetch metadata and changed files**
   - GitHub: `gh pr view <number> --json title,body,author,baseRefName,headRefName,isDraft,files` to get the list of changed files.
   - GitLab: `glab mr view <number>` to get the list of changed files.
2. **Build context**
   - Read the project's CLAUDE.md (or equivalent) to understand coding conventions and background.
   - If the PR/MR description references a plan file or an issue, read that too.
3. **Select reviewers and run the Workflow**
   - Select reviewers from the changed-file list obtained in step 1 (see "Selecting reviewers" above).
   - Run the Workflow in parallel, passing the following as `args.reviewContext` (substitute `<number>` and `<CLI>` with the actual values):
     ```
     Review PR/MR #<number>. Fetch the diff with `<CLI> pr/mr diff <number>`, and read the full content of
     each changed file along with its surrounding code (callers, type definitions, middleware, etc.). Don't
     judge from the diff alone. Report issues from your area of expertise, and for each finding include the
     severity, file, line, a description of the problem, and a suggested fix.
     ```
   - Use the `findings` returned by the Workflow (already sorted by severity) for the verdict step below.
4. **Run verification**
   - Detect the project type and run whatever applies.
     - Node-based: type checking (tsc, etc.), lint, tests, build. Check `package.json` scripts to pick the right ones.
     - Python-based: mypy / ruff / pytest, etc., for whichever config files are present. If a virtual environment exists (`.venv/` / `venv/`), use the tools inside it (e.g. `.venv/bin/pytest`; for poetry/uv-managed projects, run through `poetry run` / `uv run`).
     - PHP-based: phpstan / php-cs-fixer / phpunit, etc., for whichever config files are present.
     - E2E: if `playwright.config.*` (or `cypress.config.*`) exists, **always include E2E tests in the run**
       (`npx playwright test`; if the config has a `webServer`, the app starts automatically). Skip only if the
       environment can't support it, and always record why. On failure, distinguish code-caused failures from
       environment-caused ones (external service not running, missing credentials, etc.); code-caused failures
       count as a verification failure.
   - Record the results (pass/fail/skip reason) for each check.
5. **Verdict**

   Apply the shared verdict rule across all reviewers, evaluated top to bottom.

   | Condition | Verdict |
   |---|---|
   | Any CRITICAL findings | Blocked (post as change request, with BLOCKING stated at the top) |
   | Any HIGH findings, or verification failed | Changes requested |
   | MEDIUM only (verification passed) | Approve with warnings |
   | No findings / LOW only (verification passed) | Approve |

   When posting remotely: both "approve" and "approve with warnings" post as an approval; for the latter, include
   the MEDIUM findings and recommended follow-ups in the report body. If the target is a draft PR/MR, post a
   comment only regardless of verdict — don't approve or request changes.

6. **Save the review record**
   - Save it under `.claude/reviews/` as `<date>-<PR/MR number>.md` (template below).
7. **Post remotely**
   - GitHub: `gh pr review <number> --approve | --request-changes | --comment --body "<report>"`
   - GitLab: approve with `glab mr approve <number>`; post the report body with `glab mr note <number> --message "<report>"`.
     GitLab has no direct equivalent of "request changes," so for a changes-requested or blocked verdict, skip
     approval and instead state "Changes requested" or "Blocked" at the top of the note.
8. **Summarize for the user**
   - Report the verdict, finding counts by severity, verification results, the link to where it was posted, and the record file path, concisely.

## Review record template

```markdown
# Review record: <PR/MR title or "local changes">

- Date: <YYYY-MM-DD HH:MM>
- Target: <PR/MR number and URL, or branch name>
- Verdict: <Approve | Approve with warnings | Changes requested | Blocked | Comment only (draft)>

## Summary

<2-3 sentence summary of the change>

## Findings

### CRITICAL
- <file:line> <description of the problem and suggested fix> (or "None")

### HIGH
- None

### MEDIUM
- None

### LOW
- None

## Verification results

| Item | Command | Result |
|---|---|---|
| Type check | <command run> | <Pass/Fail/Skipped> |
| Lint | <command run> | <Pass/Fail/Skipped> |
| Tests | <command run> | <Pass/Fail/Skipped> |
| E2E | <command run> | <Pass/Fail/Skipped (reason)> |
| Build | <command run> | <Pass/Fail/Skipped> |

## Notes

<rebase recommendation, scope limitations, any fallback used, etc.>
```

## Edge cases

- **CLI unavailable**: if `gh` / `glab` isn't installed or authenticated, say so and fall back to a local review
  (equivalent to Mode A — diff against the checked-out target branch if available) without posting anything.
- **Very large PR/MR**: if the changed files number roughly 30+ or the diff is roughly 3000+ lines, warn that
  full coverage may not be possible, prioritize the highest-impact files (core logic, security-sensitive code,
  public APIs), and record the actual scope covered in both the saved record and the summary.
- **Branch diverged from base**: if the base branch has moved on and the target branch is stale, flag the risk
  of conflicts or inconsistent verification results and suggest a rebase (or merging in the latest base). Judge
  the verdict against the code as it currently stands.
