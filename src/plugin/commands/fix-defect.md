---
description: Fix a bug through a gated pipeline that's reproduction-test-first, proving the fix with a red-to-green transition
argument-hint: "[bug description / repro steps / issue number]"
---

# Fix-defect pipeline

Fix a reported bug through a disciplined, gated pipeline. Three things are non-negotiable:

1. **Not one line of fix code gets written until the root cause is identified.**
2. **If the code under test doesn't have adequate coverage, build that up first before going test-first.**
3. **Write a failing test that reproduces the bug before touching the fix (red), and prove the fix by
   making that same test pass (green).**

A bug that can't be reproduced can't be fixed, and a test that never went red proves nothing.
A fix without a root cause is just a symptom hidden away — and that's a failure.

Target bug: $ARGUMENTS

## Scope

- In scope: fixing "broken behavior" — something not working as expected.
- Out of scope: spec changes or new features — use /add-feature for those.
  If partway through the work it turns out this is actually a spec change rather than a bug fix,
  report that to the user and switch commands.

## Two gates

This pipeline has two gates that must never be crossed early.

1. Plan-approval gate: for standard-or-larger changes, don't write fix code until the user
   has approved the plan.
2. Commit gate: never commit without the user's confirmation, under any circumstances.

Even when it's tempting to push forward autonomously, always stop at the gate and get confirmation.

## Procedure

### 1. Declare the size classification

Before starting work, declare which of the following applies.

- Trivial: a change of one file, a few lines, with an obvious cause.
- Small: a change of one or two files, where identifying the cause takes a bit of investigation.
- Standard or larger: a change spanning multiple files, or where the cause is unclear.

Regardless of the size of the change, fixes touching authentication/authorization, input handling,
databases, external service integrations, or anything money-related are always treated as
"standard or larger."

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
# e.g. git worktree add -b fix/login-error ../worktrees/fix-login-error
```

- Name the branch after the bug (a `fix/` prefix is recommended).
- A sibling directory outside the repo is usually the most convenient path (e.g. `../worktrees/<name>`).
- If placing it inside the project (`.worktrees/`), confirm it's in `.gitignore` before creating it (`git check-ignore -q .worktrees`). If it's not listed, add it and commit that first.
- Working inside a worktree keeps the main working directory clean, and rolling back is as simple as deleting the whole directory.

Once created, run the test suite to confirm a clean baseline. If there are pre-existing failures, report them to the user and confirm whether to proceed.

### 3. Investigate the root cause (four phases)

**Iron rule: not one line of fix code until the root cause is identified.**

Don't start fixing on a hunch of "probably here." A guessed fix tends to create a different bug.

#### Phase 1: Gather facts

- **Read the error message carefully**: read the stack trace to the end.
  Record line numbers, file paths, and error codes. Don't skim.
- **Confirm the reproduction is consistent**: pin down the repro steps and check whether it
  happens every time. If it's not reproducible, gather more data instead of guessing at a fix.
- **Check recent changes**: review `git diff`, recent commits, dependency changes, and
  any configuration or environment differences.
- **In multi-layer systems, gather evidence at each boundary**: for architectures like
  API → service → DB, measure and log "input, output, state" at each component boundary to
  identify which layer is broken before digging into the cause. Don't make sweeping changes across every layer at once.
- **Trace the data flow backward**: when the error surfaces deep in the call stack, walk the
  callers back to where the bad value originated. Fix the source, not the symptom.

#### Phase 2: Pattern analysis

- Look for a working, similar implementation elsewhere in the same codebase.
- List the differences between the broken code and the working code (don't overlook small ones).
- When consulting an external library's docs or a spec, read it in full rather than skimming a section.

#### Phase 3: Hypothesize and verify

- State the hypothesis in one clear sentence: "X is the cause, because Y."
- Make the **smallest possible change** to test the hypothesis (one variable at a time).
- Don't apply multiple fixes at once — you'll lose the ability to isolate what worked.
- If the hypothesis is wrong, **form a new hypothesis from scratch** rather than layering another fix on top of the failed one.

#### Plan-approval gate (standard or larger)

Once the Phase 1-3 investigation is complete, for standard-or-larger changes, draft a fix plan,
present it to the user, and get approval. Don't write fix code before approval.
Use the planner subagent or /plan.

#### If you get stuck

- **After 3 or more failed fix attempts**: stop trying individual fixes and question the
  architecture itself. If "every fix creates a problem somewhere else" or "the fix would require
  major refactoring," that's an architectural problem. Report the situation to the user and
  propose a fundamental design review.

#### Excuses to watch for (all of them are off-limits)

| Excuse | Reality |
|---|---|
| "It's a simple bug, the process is overkill" | Even simple bugs have a root cause |
| "We're in a hurry, let's just guess a fix" | Guessing causes rework — systematic investigation is actually faster |
| "Probably here, let me try it" | Looking at the symptom isn't the same as understanding the root cause |
| "Fix it now, investigate later" | Fixing first contaminates the investigation |
| "One more fix attempt" (on the 3rd+ try) | Question the architecture instead |

### 4. Check test coverage of the affected code

Before starting the fix, check whether the affected code already has adequate test coverage.
Going test-first against inadequate coverage risks "I thought I made it red, but I just tripped
over a pre-existing defect." Proving the fix requires a test foundation that guarantees the
pre-bug, correct behavior.

What to check:

| Layer | What to confirm |
|---|---|
| Unit tests | Do they cover the normal and error paths of the affected function/method/class? |
| Integration tests | Is the affected code's interaction with external dependencies (DB, API, filesystem, etc.) verified? |
| Regression tests | Do tests exist for past, similar bugs? |

**If coverage is adequate**, move to the next step.

**If coverage is inadequate**, do the following before moving to the next step.

1. Implement the missing tests (don't write fix code yet).
2. Run the new tests and confirm they all **pass (green)**.
   If any don't pass, they may be tripping over a separate pre-existing bug, or encoding a buggy
   spec as the expected value — report this to the user and get a decision.
3. Get the added tests reviewed (see "Test review" below).
4. Resolve every CRITICAL / HIGH finding before moving to the next step.

#### Test review (only when coverage was inadequate)

Run a review using the same parallel Workflow execution as `/code-review` (Mode A).

1. Identify the added test files, and select reviewers per `/code-review`'s "Selecting reviewers" table (`code-reviewer` is always included).
2. Invoke the Workflow script described in `/code-review` and run the selected reviewers in parallel.
3. Resolve every CRITICAL / HIGH finding, and re-run the tests to confirm they're all green.

### 5. Write a regression test and confirm it fails (red)

**Iron rule: fix code must never be written before the test.**

If you accidentally write fix code before the test, **discard it immediately** and start over from writing the test.

```bash
git restore <the file you accidentally fixed>
```

"It was just a small change," "I'll write the test right after" are not acceptable excuses. A fix without a test is an unproven claim.

---

- Write a regression test that reproduces the bug, at whichever layer best reproduces it
  (a logic bug calls for a unit test; a bug involving DB reads/writes, queries, or transactions
  calls for an integration test against a real database; a bug in a cross-screen flow may call
  for an E2E test).
- Run the test and **confirm it fails**.
- Check that the failure (error message, expected vs. actual value) matches the reported bug.
  If it doesn't match, your understanding of the root cause is likely wrong — go back to step 3.

#### Test anti-patterns (avoid these)

- **Testing that a mock was called**: a test that only confirms a mock exists proves nothing
  about actual behavior. Test the implementation.
- **Using a mock without understanding it**: understand the side effects of the method being
  mocked before mocking it. Mocking "just in case" strips out the side effects it depends on and
  makes the test meaningless.
- **Incomplete mock objects**: include every field the real API actually returns. A mock missing
  some fields lets code that depends on those fields slip through untested.
- **Adding test-only methods to production code**: put test cleanup helpers and the like in test
  utilities. Don't pollute production classes with them.

### 6. Fix the root cause (green)

- Fix the root cause identified in step 3.
- **Don't hide the symptom**: don't swallow exceptions, special-case around the failing
  scenario with a conditional, or loosen a test's expected value just to make it pass.
- Confirm the regression test goes green.
- Run the existing test suite and confirm there's no regression. Include E2E tests
  (`playwright.config.*` etc., if present). If they can't run due to environment constraints,
  report that to the user.
- If the fix spans multiple repositories, run the test suite in every repository that was
  changed and confirm there's no regression.
- If the build breaks, restore it with /build-fix before continuing.

#### Defense-in-depth validation

If the bug was caused by invalid data flowing through the system, consider not just fixing the
one spot but adding validation at every layer the data passes through, making the bug
**structurally impossible** rather than merely patched.

| Layer | What to add |
|---|---|
| Entry point | Reject invalid values early at the API/endpoint |
| Business logic | Add a guard at the entry of the processing function too |
| Environment guard | Block dangerous operations in specific contexts, like test runs |
| Debug logging | Log the stack trace and input values to make future investigation easier |

Each layer catches a different code path or a different mock-based bypass.
Whether every layer is needed depends on the nature of the bug. Include which layers you applied and why in the change.

#### Logging considerations (for projects that follow a logging convention)

Alongside the fix, check the following.

- If **ERROR/WARN logging was missing** at the point that caused the bug, add it now
  (ask yourself: would this log have caught the bug earlier?).
- Confirm ERROR logs include the exception, `request_id`, and the ID of the affected resource.
- Confirm the correlation ID for requests passing through the fixed code is consistent end-to-end across the logs.
- See your project's logging conventions doc for details.

### 7. Get a review

Run a review using the same parallel Workflow execution as `/code-review` (Mode A).

1. Identify the changed files with `git diff HEAD --name-only`, and select reviewers per `/code-review`'s
   "Selecting reviewers" table (`code-reviewer` and `silent-failure-hunter` are always included).
2. Invoke the Workflow script described in `/code-review` and run the selected reviewers in parallel.
3. Review the returned `findings` and resolve every CRITICAL / HIGH finding.
   After making the fixes, re-run step 6's checks (regression test green, no regressions).

### 8. Verify before declaring done (no claims without evidence)

**Iron rule: run the verification commands and read the output before claiming completion.**

"Should pass," "probably fine," "I don't think there's a problem" are guesses, not claims.
Before crossing the commit gate, actually run the following **in this conversation** and confirm:

| Claim | Required evidence |
|---|---|
| Tests pass | Ran the test command and saw zero failures in the output |
| Regression test went red then green | Ran both the pre-fix red and the post-fix green and confirmed each |
| Build passes | Ran the build command and saw exit code 0 |
| The bug is fixed | Confirmed the operation/test that reproduces the original symptom now passes |
| No regressions | Ran the existing test suite and confirmed no failures |

All of the following are prohibited:

- Claiming completion with phrases like "should pass," "probably," "I believe"
- Claiming something "passes" based on a previous run (a stale result is not evidence)
- Trusting a subagent's "done successfully" report without verifying it yourself
- Reporting partial verification (only some tests) as complete verification
- Skipping verification because you're tired or in a hurry

### 9. Commit and clean up the worktree (commit gate)

- Present a summary of the diff and a proposed commit message, and wait for the user's confirmation.
- Commit only once confirmation is given.
- Follow the project's existing conventions (commit log style, etc.) for message format and granularity.

After committing, present the user with these four options.

```
The fix is complete. What would you like to do with this change?

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
git merge <fix-branch>
# Run the test suite after merging to confirm no regression
git worktree remove <worktree-path>
git worktree prune
git branch -d <fix-branch>
```

**2. Open a PR**

```bash
git push -u origin <fix-branch>
gh pr create --base <base-branch> --head <fix-branch> \
  --title "<fix title>" --body "<summary of the fix and root cause>"
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
git branch -D <fix-branch>
```

**Order and prohibitions to observe**

- Never run `git worktree remove` from inside the worktree (always move to the main repo root first).
- Run `git branch -d` **after** `git worktree remove` (the reverse order fails).
- Don't remove the worktree before the merge (confirm the merge succeeded first).
- Don't remove the worktree after creating a PR (option 2).

## Verification checklist

Before reporting completion, confirm all of the following.

- [ ] Identified the root cause at the code level before fixing (not a guess).
- [ ] Checked the affected code's test coverage. If it was inadequate, added tests first, got them reviewed, and only then moved to the next step.
- [ ] Wrote the test before writing the fix code (if the fix was accidentally written first, it was discarded and redone).
- [ ] Confirmed the regression test was red before the fix and green after.
- [ ] No regressions in the existing test suite (including E2E tests, if present).
- [ ] If the fix spans multiple repositories, ran the test suite in every changed repository and confirmed no regression.
- [ ] Fixed the root cause rather than hiding the symptom.
- [ ] Resolved every CRITICAL / HIGH review finding.
- [ ] Ran verification commands and read the output before claiming completion (didn't guess "should pass").
- [ ] Committed only after the user's confirmation (left uncommitted if not yet confirmed).
- [ ] Presented the four-option worktree cleanup and executed it in the correct order (remove worktree → delete branch) for the chosen option.
- [ ] If a logging convention applies: filled in logging that was missing at the point of the bug, and confirmed ERROR logs include the correlation ID and affected resource ID.
