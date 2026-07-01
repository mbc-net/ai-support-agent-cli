---
description: Create an implementation plan grounded in the codebase's existing patterns before writing any code, and don't start implementing until it's approved
argument-hint: "[free-form request | path to a requirements markdown file | leave empty]"
resumable: true
---

# /plan - Create an implementation plan

A command for drafting an implementation plan before writing code and getting the user's approval on it.
It exists to prevent rework, misalignment, and drift from existing patterns that come from starting to implement without a plan.

## Interpreting the input

Evaluate `$ARGUMENTS` in this order.

1. **Path to a markdown file**: read the file and treat its contents as the requirements/reference material.
2. **Free-form text**: treat the text as the implementation request.
3. **Empty input**: ask "What would you like a plan for? Please also share the purpose, background, and any constraints," and wait for the answer before continuing.

## Procedure

### Step 1: Restate the request

Restate the request you received in your own words, in one to three sentences, and present it up front.
Explicitly list any points open to interpretation and any assumptions you made.
This step must not be skipped — it lets the user catch a mismatch between your restatement and their actual request early.

### Step 2: Clarifying questions

**This step can be skipped for trivial changes. It is required for small and larger changes.**

Organize the ambiguities and open points left over from the restatement (Step 1) using the perspectives below,
and ask the user about them together in one batch. Don't re-ask about anything already clear. Wait for the answer before moving to the next step.

| Perspective | What to confirm |
|---|---|
| Target users and permissions | Who will use this feature? What permissions/preconditions are needed to operate it? |
| Non-functional requirements | Are there performance, throughput, or scale targets? |
| Backward compatibility and constraints | Must existing APIs, data formats, or external integrations be preserved? Are any technologies off-limits? |
| Failure behavior | What should be returned to the user on failure? Is a rollback needed? |
| Definition of done | What state counts as "complete"? Are there acceptance criteria? |

If there's nothing unclear, declare "No clarifying questions" and move on.
Fold the user's answers directly into the plan and the codebase investigation that follows.

### Step 3: Codebase investigation

Search the existing implementation for related code to ground the plan in. Investigate from these angles:

- Naming conventions (file names, class names, function names, variable names)
- Error-handling approach (exceptions, return values, error types, retries)
- Logging approach (logger type, log-level usage, output format)
- Data-access approach (ORM, repository layer, query style)
- Testing conventions (framework, file placement, naming, mocking style)

**Important**: if no similar code exists, say so honestly — "no matching existing pattern was found."
Never fabricate a pattern that doesn't exist. Back every claim with a real file path.

### Step 4: Draft the plan

Based on the investigation, break the implementation into phases, and break each phase into steps.
Attach to each step: the target file path, what to do, why, dependencies, and risk level (High/Medium/Low).
Also include the test strategy (whether unit/integration/E2E tests are needed and what they cover), success criteria, and an overall complexity estimate (High/Medium/Low).

For large plans — four or more phases, or more than ten affected files — you may delegate investigation and drafting to the planner subagent. Even then, this command handles the final presentation and approval check.
(For a 3-phase plan, write the "Interfaces between phases" section yourself as described below; delegation is for four-plus phases.)

#### No placeholders allowed

Every step in the plan must be concrete enough to execute as written.
Any of the following counts as **a failed plan** and must not appear:

- "TBD," "TODO," "implement later," "details elsewhere"
- "Add appropriate error handling," "add validation," "handle edge cases" (without saying what, specifically)
- A step involving a code change with no code sample
- "Same as Phase N" (later steps must not reference earlier ones — repeat what's needed instead)
- Forward references to types, functions, or methods that aren't defined until a later step (e.g., a type used in Step N but only defined in Step N+1 or later)

#### Interfaces between phases (large plans)

For plans with three or more phases, add the following at the end of each phase:

- **Inputs**: the artifacts this phase depends on from prior phases (name the specific function names, types, and file paths)
- **Outputs**: what this phase hands off to later phases (name the specific function names, types, and file paths)

The goal is for whoever implements a later phase to be able to work without reading the earlier phase's details.

### Step 5: Self-review the plan

Before presenting the plan, check it yourself against these three points.
Fix any issues found on the spot. If nothing is wrong, move to the next step.

1. **Requirement coverage**: does every requirement (from the request or requirements file) have a corresponding step?
   Add a step for any requirement that's missing one.

2. **Placeholder scan**: search for anything matching the "No placeholders allowed" list in Step 4.
   Rewrite anything found into something concrete.

3. **Name consistency**: are function, type, and constant names defined in earlier steps referenced by
   the same names in later steps? Reconcile any mismatches.
   After reconciling, re-run Check 1 (requirement coverage) and Check 2 (placeholder scan)
   to make sure the renaming didn't introduce new problems.

### Step 6: Present the plan

Output the plan using the following template.

```markdown
# Implementation Plan: <title>

## Restated request
<the request in your own words, 1-3 sentences, including assumptions and interpretations>

## Complexity estimate
High / Medium / Low — <one-sentence rationale>

## Existing patterns to follow
| Aspect | Pattern to use | Evidence (real file path) |
|------|----------------|--------------------------|
| Naming | ... | ... |
| Error handling | ... | ... |
| Logging | ... | ... |
| Data access | ... | ... |
| Testing | ... | ... |

*For any aspect with no matching pattern, write "No existing pattern (proposing a new approach)."*

## Implementation phases

### Phase 1: <phase name>
| # | Target file | What to do | Why | Depends on | Risk |
|---|------------|---------|------|------|--------|
| 1-1 | path/to/file | ... | ... | none | Low |
| 1-2 | path/to/file | ... | ... | 1-1 | Medium |

<!-- Only for plans with 3+ phases -->
- **Inputs**: (outputs from the prior phase; Phase 1 is "none")
- **Outputs**: `functionName(arg: Type): ReturnType` — defined in path/to/file

### Phase 2: <phase name>
| # | Target file | What to do | Why | Depends on | Risk |
|---|------------|---------|------|------|--------|
| 2-1 | path/to/file | ... | ... | none | Low |
| 2-2 | path/to/file | ... | ... | 2-1 | Medium |

<!-- Only for plans with 3+ phases -->
- **Inputs**: Phase 1's `functionName(arg: Type): ReturnType` — path/to/file
- **Outputs**: `functionName2(arg: Type): ReturnType2` — defined in path/to/file

## Test strategy
- Unit tests: <scope and approach>
- Integration tests: <scope and approach, or why they're not needed>
- E2E tests: <scope and approach, or why they're not needed>

## Success criteria
- [ ] <verifiable criteria as a checklist>

## Risks and mitigations
- <risk>: <mitigation>
```

### Step 7: Confirm approval

After presenting the plan, always ask: "Should I go ahead and start implementing this plan?"

**The most important rule: don't write a single line of code until the user explicitly approves.**
That includes creating or editing files, committing, and any "just a small preview" implementation.

Handle the user's response as follows:

- **Approval** ("OK," "go ahead," "approved," etc.): start implementing according to the plan.
- **Requested changes** ("change this part," "drop Phase 2," etc.): revise the affected part of the plan, re-present it, and ask for approval again. Re-run the Step 5 self-review (all three checks) before re-presenting.
- **Request for an alternative** ("try a different approach," etc.): draft a plan with a different approach and re-present it, optionally with a comparison table against the original.
- **Rejection/abandonment**: discard the plan and don't implement anything.

## Completion Marker Convention

This command runs under `claude -p` (non-interactive), which restarts as a fresh process every turn — past turn 1, this command body is not guaranteed to be re-expanded, so gate discipline can silently erode across turns. To compensate, a hooks-based mechanism re-injects a digest of this command's must-obey constraints on the next turn whenever the flow is left incomplete.

If this command's flow is **not yet complete** (e.g. stopped at Step 7's approval gate, waiting on clarifying questions, etc.), your response **MUST end** with a line that is an exact match of:

`<!-- ai-support-agent:resume name="plan" -->`

If the flow **is complete** (final user approval was obtained, or the plan was rejected/discarded), do **not** output this marker.

Never output this marker inside a code block or as an illustrative example — only emit it as the actual last line of real output when the flow is genuinely incomplete.

<!-- RESUME_DIGEST_START -->
When resuming this command on turn 2+ without the full command body re-expanded, obey these constraints:

- **Approval gate (Step 7)**: don't write a single line of code — no creating/editing files, no committing, no "just a small preview" — until the user explicitly approves the presented plan. Silence or a vague "sounds good" is not approval; ask "Should I go ahead and start implementing this plan?" and wait for an explicit yes.
- Handle the user's response per Step 7: approval → start implementing; requested changes → revise only the affected part, re-present, and ask for approval again; request for an alternative → draft and present a different approach; rejection/abandonment → discard the plan and implement nothing.
- Never self-interpret "roughly agreed to," silence, or an unrelated follow-up question as approval.
- If clarifying questions (Step 2) are still outstanding for a small/standard-or-larger change, wait for the user's answers before drafting or re-drafting the plan.
- Before presenting (or re-presenting) any plan, re-run the Step 5 self-review's three checks:
  1. Requirement coverage — every requirement has a corresponding step.
  2. Placeholder scan — no "TBD," "TODO," "add appropriate error handling," "same as Phase N," or forward references to undefined types/functions.
  3. Name consistency — function/type/constant names match across steps; re-run checks 1 and 2 after any renaming.
- **No placeholders allowed**: every step must be concrete enough to execute as written. A step with a code change but no code sample, or a vague instruction without specifics, is a failed plan.
- Every claim in the plan (patterns, existing code) must be backed by a real file path — never fabricate a pattern that doesn't exist; say "no matching existing pattern was found" if that's the truth.
- Once the user approves, implementation may begin; until then, remain at the gate and keep emitting the resume marker on every incomplete turn.
<!-- RESUME_DIGEST_END -->

## After implementation is done

Once the plan is approved and implementation is complete, point to the next command as appropriate:

- Code review: /code-review
- Resolving build errors: /build-fix
- Checking test coverage: /test-coverage
- Keeping docs in sync: /update-docs
