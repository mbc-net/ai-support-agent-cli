---
description: Evaluate a session's insights through a quality gate, keeping only records worth saving
argument-hint: "[optional topic to focus the extraction on]"
---

# /learn-eval - Record insights through a quality gate

The strict version of /learn. After extracting insights, it runs them through a quality gate to keep
memory and CLAUDE.md from bloating with low-value records. If you just want a quick save, use /learn instead.

## Procedure

### 1. Extract insights

Reflect on the session and surface candidate insights worth reusing: root causes and fixes for errors,
non-obvious debugging techniques, library quirks or version-specific workarounds, and project-specific
conventions or design decisions. Trivial fixes and one-off incidents don't count as candidates.
If an argument is given, narrow this to insights related to that topic.

### 2. Mandatory checks (run for every candidate)

For each candidate, always confirm the following. None of these may be skipped.

1. Search existing memory: search both global and project memory files for the same or a near-duplicate record.
2. Cross-check the index: check MEMORY.md and each level's CLAUDE.md for duplicate content.
3. Consider appending instead: decide whether appending to/updating an existing record would be better than creating a new one.
4. Confirm reusability: confirm there's a concrete, plausible future scenario where this would actually get referenced.

### 3. Quality evaluation

Score each candidate on the following four dimensions, each as High/Medium/Low.

- Concreteness: does it include ready-to-use code, commands, or steps? Or is it just an abstract lesson?
- Focus: is it scoped to one record, one pattern? Or does it mix multiple topics?
- Novelty: is this information not already in an existing record or in general official documentation?
- Reuse likelihood: is it realistic that the same situation will recur?

### 4. Verdict

Based on the evaluation, assign each candidate one of the following four verdicts.

| Verdict | Rough criteria |
|------|-----------|
| Save | Passes the mandatory checks, and all four dimensions score Medium or higher |
| Improve then save | Has value, but concreteness or focus scores low. Re-evaluate once after improving. |
| Merge into an existing record | Useful, but overlaps or nearly duplicates an existing record |
| Discard | Novelty or reuse likelihood is low — not worth recording |

Re-evaluation for "improve then save" happens once only. If it still doesn't meet the bar after that, discard it.

### 5. Present the check results

Present the results for each candidate in the following format.

```
Insight: [name]
Verdict: [Save / Improve then save / Merge into an existing record / Discard]
Scores: Concreteness=[High/Medium/Low] Focus=[High/Medium/Low] Novelty=[High/Medium/Low] Reuse likelihood=[High/Medium/Low]
Duplicate check: [None / Yes (name of the existing record)]
Rationale: [1-2 sentence basis for the verdict]
```

### 6. Confirmation flow per verdict

- Save: present the draft record and destination to the user, and save after approval.
- Improve then save: re-evaluate the improved draft, and proceed to the save flow once it passes.
- Merge into an existing record: present the target record and the content to append, and update after approval.
- Discard: just explain why. Don't write anything to a file.

### 7. Saving

Save to the memory feature (individual memory files plus the MEMORY.md index) if available; otherwise
append to the appropriate section of the CLAUDE.md at the applicable level.
Decide the level (global vs. project) by whether it would help in other projects too — when in doubt, go global.

Record format:

```markdown
## [Insight name]

- Applies when: which environment, version, or situation this holds for
- Problem: what happened
- Solution: concrete steps, code, or commands
- When to use this: what future situation should trigger looking this up
- Recorded: YYYY-MM-DD
```

## Notes

- Don't save things "just in case." When in doubt, lean toward discarding, and state why.
- Respect the user's objection to a verdict — if the user wants something saved, they can override the verdict.
- Even if every candidate gets discarded, report that outcome and the reasons as a list.

Note: the extraction criteria, storage-level rules, and record format are intentionally duplicated between learn.md and learn-eval.md, since each command needs to be self-contained. Keep both files in sync when changing either.
