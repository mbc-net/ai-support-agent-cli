---
description: Implement a new feature through a disciplined, gated pipeline of plan approval and test-first development
argument-hint: "[feature description / requirements / issue number]"
resumable: true
---

# Add-feature pipeline

Implement a new feature or a change in behavior through a disciplined, gated pipeline. Two things are non-negotiable:

1. **Not one line of implementation code gets written until the user approves the plan.**
2. **Every task is test-first (red → green → refactor).**

Target feature: $ARGUMENTS

## Scope

- In scope: adding new features, changing existing behavior.
- Out of scope: fixing broken behavior — use /fix-defect for that.
  If partway through the work it turns out this is actually a bug fix rather than a feature addition,
  report that to the user and switch commands.

## Two gates

This pipeline has two gates that must never be crossed early.

1. Plan-approval gate: don't write implementation code until the user has approved the plan.
   Reads for investigation and planning are fine before approval; adding or changing production
   or test code starts only after approval.
2. Commit gate: never commit without the user's confirmation, under any circumstances.

Even when it's tempting to push forward autonomously, always stop at the gate and get confirmation.

## Completion Marker Convention

This command runs under `claude -p` (non-interactive), which restarts as a fresh process every turn — past turn 1, this command body is not guaranteed to be re-expanded, so gate discipline (the two gates above) can silently erode across turns. To compensate, a hooks-based mechanism re-injects a digest of this command's must-obey constraints on the next turn whenever the pipeline is left incomplete.

If this command's flow is **not yet complete** (e.g. stopped at the plan-approval gate, mid-implementation, awaiting review fixes, or stopped at the commit gate), your response **MUST end** with a line that is an exact match of:

`<!-- ai-support-agent:resume name="add-feature" -->`

If the flow **is complete** (implementation finished, committed with user confirmation, and the post-commit options were handled), do **not** output this marker.

Never output this marker inside a code block or as an illustrative example — only emit it as the actual last line of real output when the flow is genuinely incomplete.

<!-- RESUME_DIGEST_START -->
When resuming this command on turn 2+ without the full command body re-expanded, obey these constraints:

- **Two gates, never crossed early**:
  1. Plan-approval gate: no implementation or test code changes until the user has explicitly approved the plan. Reads/investigation are fine before approval.
  2. Commit gate: never commit without the user's explicit confirmation, under any circumstances.
- Never self-interpret "roughly agreed to," silence, or an unrelated follow-up as approval or as commit confirmation.
- **Test-first is non-negotiable**: for every task, write the test before the implementation, run it, and confirm it fails (red) before writing any implementation code. Then implement the minimal code to go green, then refactor while staying green.
- **Do all work inside the dedicated worktree** created in Step 2 — never edit the main working tree directly.
- **Step 9 verification requires evidence, not speculation**: never claim "tests pass" / "build passes" / "should work" without having actually run the command in this conversation and read its output. A stale or previous run's result does not count as evidence.
- **Review gate (Step 8)**: every CRITICAL / HIGH finding from the code-reviewer / silent-failure-hunter review must be resolved, followed by a green re-run of the test suite, before moving on.
- Follow the Step 10 commit-gate flow exactly: present the diff + proposed commit message, wait for confirmation, commit only after confirmation, then present the four post-commit options and execute the chosen one in the correct order (never remove a worktree before merge/PR is settled).
<!-- RESUME_DIGEST_END -->

## Procedure

### 1. Declare the size classification

Before starting work, declare which of the following applies.

- Trivial: a small addition — one file, a handful of lines. The plan can be an abbreviated,
  key-points-only version, but presenting it and getting approval is still not optional.
- Small: an addition spanning a few files, with a clear, easy-to-see-through path.
- Standard or larger: an addition touching multiple modules, or involving design decisions.

Regardless of size, changes touching authentication/authorization, input handling, databases,
external service integrations, or anything money-related always require a formal plan and approval.

### 2. Create a worktree

Create a dedicated branch and worktree for the work, and do everything from here on inside that worktree.

First check the existing isolation state.

```bash
MAIN_ROOT=$(git rev-parse --show-toplevel)
GIT_DIR=$(cd "$(git rev-parse --git-dir)" 2>/dev/null && pwd -P)
GIT_COMMON=$(cd "$(git rev-parse --git-common-dir)" 2>/dev/null && pwd -P)
SUPERPROJECT=$(git rev-parse --show-superproject-working-tree 2>/dev/null)
echo "MAIN_ROOT=$MAIN_ROOT"
echo "GIT_DIR=$GIT_DIR"
echo "GIT_COMMON=$GIT_COMMON"
echo "SUPERPROJECT=${SUPERPROJECT:-(none)}"
```

Use the output above to determine which of three states applies.

| Condition | State | Action |
|---|---|---|
| `SUPERPROJECT` has a value | Inside a submodule | Don't create a worktree — work directly |
| `SUPERPROJECT` is empty and `GIT_DIR != GIT_COMMON` | Already inside a worktree | Don't create a new one — keep working in the existing worktree |
| `SUPERPROJECT` is empty and `GIT_DIR == GIT_COMMON` | Regular repository | Create a worktree (steps below) |

Create the worktree.

```bash
git worktree add -b <branch-name> <path>
# e.g. git worktree add -b feature/add-user-auth ../worktrees/add-user-auth
```

- Name the branch after what the feature does.
- A sibling directory outside the repo is usually the most convenient path (e.g. `../worktrees/<name>`).
- If placing it inside the project (`.worktrees/`), confirm it's in `.gitignore` before creating it (`git check-ignore -q .worktrees`). If it's not listed, add it and commit that first.
- Working inside a worktree keeps the main working directory clean, and rolling back is as simple as deleting the whole directory.

Once created, run the test suite to confirm a clean baseline. If there are pre-existing failures, report them to the user and confirm whether to proceed. If proceeding, record those failures as pre-existing issues outside the scope of this work (so they aren't later mistakenly reported as a regression introduced here).

### 3. Investigate the existing code

Before settling on an implementation approach, investigate the codebase first.

- Look for reusable implementations: existing utilities, shared components,
  similar features. Don't reinvent the wheel.
- Identify the patterns to follow: directory structure, naming conventions,
  error-handling approach, testing conventions.
- If an existing mechanism already satisfies the requirement, use it instead of building something new.

### 4. Clarifying questions

**This step can be skipped for trivial changes. It is required for small and larger changes.**

Building on the codebase investigation, organize the ambiguities and open points left over from restating
the request using the perspectives below, and ask the user about them together in one batch. Don't re-ask
about anything already clear. Wait for the answer before moving to the next step.

| Perspective | What to confirm |
|---|---|
| Target users and permissions | Who will use this feature? What permissions/preconditions are needed to operate it? |
| Non-functional requirements | Are there performance, throughput, or scale targets? |
| Backward compatibility and constraints | Must existing APIs, data formats, or external integrations be preserved? Are any technologies off-limits? |
| Failure behavior | What should be returned to the user on failure? Is a rollback needed? |
| Definition of done | What state counts as "complete"? Are there acceptance criteria? |

If there's nothing unclear, declare "No clarifying questions" and move on.
Fold the user's answers directly into the plan.

### 5. Draft a plan and get it approved (plan-approval gate)

- Use the planner subagent or /plan to draft the plan. The plan should include
  the implementation approach, what will change, a task breakdown, test strategy, and risks.
- Present the plan to the user and wait for approval. Don't start implementing before approval.
- If changes are requested, revise the plan and re-present it, and get approval again.
  Never self-interpret "roughly agreed to" as approval and start implementing.

### 6. Write tests first and confirm red

Write tests before writing implementation code.

- Following the approved plan's task breakdown, write each task's tests first.
- Run the tests and **confirm they fail (red)**.
  A test that doesn't go red proves nothing about the implementation — always watch the failure happen.
- Choose the test layer appropriate to what's being tested (tasks involving DB reads/writes should
  include integration tests against a real database — see the integration-testing skill).
- For features touching critical UI flows (authentication, registration/updates, payments, etc.),
  consider adding or updating E2E tests (see the e2e-testing skill).

### 7. Implement (green → refactor)

- Work in thin vertical slices. Build up small, working increments rather than
  one large change that stays broken for a long time.
- For each task, write the minimal implementation that makes step 6's tests pass (green).
  Once green, clean up the code (refactor) while staying green.
- If the build breaks, restore it with /build-fix before continuing.
- Include E2E tests (if `playwright.config.*` etc. exists) when running the test suite.
  If they can't run due to environment constraints, report that to the user.
- If the change spans multiple repositories, run the test suite in every repository that was
  changed and confirm there's no regression.
- Use /test-coverage if you want to check whether test coverage is adequate.
- If you need to deviate from the plan, don't just proceed — consult the user first.

#### Logging considerations (for projects that follow a logging convention)

Alongside implementation, check the following.

- **New entry points** (endpoints, jobs, workers) should set `request_id` / `user_id` / `tenant_code`
  (or equivalent) in the logging context at the start of the request.
- **Business events** (state transitions, key start/completion points) should be logged at INFO level.
- **Public methods in the service/use-case layer** should emit DEBUG-level start/end, input/output,
  and duration, ideally via a cross-cutting mechanism like a decorator.
- **ERROR logs** should include the exception, stack trace, `request_id`, and the ID of the affected resource.
- Passwords, tokens, and personal information must be masked even at DEBUG level.
- See your project's logging conventions doc for details.

### 8. Get a review

Run a review using the same parallel Workflow execution as `/code-review` (Mode A).

1. Identify the changed files with `git diff HEAD --name-only`, and select reviewers per `/code-review`'s
   "Selecting reviewers" table (`code-reviewer` and `silent-failure-hunter` are always included).
2. Invoke the Workflow script described in `/code-review` and run the selected reviewers in parallel.
3. Review the returned `findings` and resolve every CRITICAL / HIGH finding.
   After making the fixes, re-run the test suite and confirm it's green.

### 9. Verify before declaring done (no claims without evidence)

**Iron rule: run the verification commands and read the output before claiming completion.**

"Should pass," "probably fine," "I don't think there's a problem" are guesses, not claims.
Before crossing the commit gate, actually run the following **in this conversation** and confirm:

| Claim | Required evidence |
|---|---|
| TDD red was confirmed | Ran it right after writing the test and watched it fail (red) |
| Tests pass | Ran the test command and saw zero failures in the output |
| Build passes | Ran the build command and saw exit code 0 |
| Requirements are met | Re-read the plan's task breakdown and confirmed each item was achieved |
| No regressions | Ran the existing test suite and confirmed no failures |

All of the following are prohibited:

- Claiming completion with phrases like "should pass," "probably," "I believe"
- Claiming something "passes" based on a previous run (a stale result is not evidence)
- Trusting a subagent's "done successfully" report without verifying it yourself
- Reporting partial verification (only some tests) as complete verification
- Jumping from "tests pass" to "requirements are met" (test passage does not imply requirement satisfaction)

### 10. Commit and clean up the worktree (commit gate)

- Present a summary of the diff and a proposed commit message, and wait for the user's confirmation.
- Commit only once confirmation is given.
- Follow the project's existing conventions (commit log style, etc.) for message format and granularity.

After committing, present the user with these four options.

```
Implementation is complete. What would you like to do with this change?

1. Merge it into <base branch> locally
2. Push and open a Pull Request
3. Keep this branch as-is (handle it later)
4. Discard this work
```

Handle each choice as follows.

**1. Local merge**

```bash
# Move out of the worktree (to the main repo root) before running this
cd "$MAIN_ROOT"
git checkout <base-branch>
git pull
git merge <feature-branch>
# Run the test suite after merging to confirm no regression
git worktree remove <worktree-path>
git worktree prune
git branch -d <feature-branch>
```

**2. Open a PR**

```bash
git push -u origin <feature-branch>
gh pr create --base <base-branch> --head <feature-branch> \
  --title "<change title>" --body "<summary of the change>"
# Don't remove the worktree — it's needed for handling PR feedback
```

**3. Keep as-is**

Leave both the worktree and the branch in place. Tell the user the path and stop.

**4. Discard**

Ask the user to type `discard` first, and only proceed once confirmed.

```bash
cd "$MAIN_ROOT"
git worktree remove <worktree-path>
git worktree prune
git branch -D <feature-branch>
```

**Order and prohibitions to observe**

- Never run `git worktree remove` from inside the worktree (always move to the main repo root first).
- Run `git branch -d` **after** `git worktree remove` (the reverse order fails).
- Don't remove the worktree before the merge (confirm the merge succeeded first).
- Don't remove the worktree after creating a PR (option 2).

## Verification checklist

Before reporting completion, confirm all of the following.

- [ ] Created a worktree and ran the baseline tests to confirm a clean starting point (any pre-existing failures were recorded).
- [ ] Investigated existing implementations and patterns, and avoided unnecessary new implementation.
- [ ] For small/standard-or-larger changes, asked clarifying questions and resolved open points before drafting the plan.
- [ ] The plan was approved by the user, and no implementation code was written before approval.
- [ ] Wrote tests first for every task and confirmed red before implementing.
- [ ] No regressions in the existing test suite (including E2E tests, if present).
- [ ] If the change spans multiple repositories, ran the test suite in every changed repository and confirmed no regression.
- [ ] Resolved every CRITICAL / HIGH review finding.
- [ ] Ran verification commands and read the output before claiming completion (didn't guess "should pass").
- [ ] Committed only after the user's confirmation (left uncommitted if not yet confirmed).
- [ ] Presented the four-option worktree cleanup and executed it in the correct order (remove worktree → delete branch) for the chosen option.
- [ ] If a logging convention applies: added correlation-ID context to new entry points, logged business events at INFO, and masked sensitive information.
