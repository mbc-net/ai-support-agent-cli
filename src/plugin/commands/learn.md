---
description: Reflect on the session and record reusable insights for future sessions
argument-hint: "[optional topic to focus the extraction on]"
---

# /learn - Record insights from a session

Reflect on the current session and extract insights worth saving for reuse in future sessions.
If an argument is given, narrow the extraction to insights related to that topic.

## Procedure

### 1. Reflect on the session and extract insights

Look back over the whole session and surface anything that fits these categories.

What to extract:
- Root causes and fixes for errors (things you could act on immediately if this recurs)
- Non-obvious debugging techniques (an investigation approach or way of narrowing down the cause that was distinctive)
- Library quirks or version-specific workarounds
- Project-specific conventions or design decisions (including context that isn't obvious just from reading the code)

What to exclude:
- Trivial fixes like typo corrections
- One-off incidents (an outage at a specific time, a transient glitch in a specific environment)
- General knowledge that's obvious from official documentation

If nothing qualifies, report "No insights worth recording were found" and stop.

### 2. Decide the storage level

For each insight, judge it against "would this help in other projects too?"

- Useful in other projects → global (user-level)
- Only meaningful in this project → project-level
- When in doubt → save it globally

### 3. Decide where to save it

Check whether a memory feature (individual memory files plus a MEMORY.md index) is available.

- If available: create an individual memory file for each insight, and add a one-line entry to the MEMORY.md index.
- If not available: append to the appropriate section of the CLAUDE.md at the level decided in step 2.
  If no matching section exists, create a new "Lessons learned" section.

### 4. Check for duplicates

Before saving, search existing memory files, MEMORY.md, and CLAUDE.md for the same or similar content
already on record. If a duplicate or near-duplicate is found, propose appending to/updating the existing
record instead of creating a new one.

### 5. Draft the record

Draft using the following format.

```markdown
## [Insight name (concise and easy to search for)]

- Applies when: which environment, version, or situation this holds for
- Problem: what happened, what the symptoms were
- Solution: concrete steps, code, or commands
- When to use this: what future situation should trigger looking this up
- Recorded: YYYY-MM-DD
```

Prefer including code or commands in the solution that can be copied and used as-is.

### 6. Confirm with the user and save

Present the draft and the intended location (level and file) to the user and get confirmation.

- If approved: save it and report the path where it was saved.
- If changes are requested: revise and re-present.
- If deemed unnecessary: finish without saving.

If there are multiple insights, present them as a list and let the user choose which to save.

## Notes

- One record, one pattern. Split multiple insights into separate records.
- Don't record speculation — only facts actually confirmed during the session.
- For a stricter quality gate, use /learn-eval instead.

Note: the extraction criteria, storage-level rules, and record format are intentionally duplicated between learn.md and learn-eval.md, since each command needs to be self-contained. Keep both files in sync when changing either.
