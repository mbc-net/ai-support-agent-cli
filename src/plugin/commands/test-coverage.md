---
description: Measure test coverage, identify important uncovered paths, and present a prioritized plan for adding tests.
argument-hint: "[target directory/file | leave empty for the whole project]"
---

# /test-coverage command

**Input**: $ARGUMENTS

A command whose goal isn't "raise the number" but "close off the highest-risk gaps" — it measures coverage and points at what actually matters.

## Behavior

### 1. Measure coverage

Detect the project type and measure accordingly:

| Stack | Command |
|---|---|
| Jest | `npx jest --coverage --coverageReporters=text-summary --coverageReporters=text` |
| Vitest | `npx vitest run --coverage` |
| pytest | `pytest --cov --cov-report=term-missing` |
| PHPUnit | `./vendor/bin/phpunit --coverage-text` (requires Xdebug/PCOV) |

If `$ARGUMENTS` specifies a path, scope the measurement to it. If no coverage tool is set up, present setup instructions and stop (don't add dependencies on your own).

### 2. Risk-assess the uncovered code

Evaluate by **the importance of what's uncovered**, not by how many lines are uncovered in the report:

| Priority | Scope |
|---|---|
| High | Payments/billing, authentication, authorization checks, data writes/deletes, external API integrations, error-handling branches |
| Medium | Business-logic branches, validation, data transformation |
| Low | Display formatters, reading config values, trivial getters |

Flag tests with weak assertions (tests that merely execute code without verifying anything), even if coverage is high.
Also flag any path involving DB reads/writes that is **covered only by mocked tests** (green in the coverage report but never verified against a real DB) as a gap needing an integration test against a real database (see the integration-testing skill).

### 3. Report

```
## Coverage report

Overall: <n>% (statements) / <n>% (branches)

### Highest-priority uncovered code
1. <file:line range> — <what it does> / <what breaks if it stays uncovered>
2. ...

### Recommended tests to add (by priority)
1. Add <case> to <test file> — <why>
2. ...
```

### 4. Add tests (only with user approval)

After presenting the report, if the user approves, add tests starting with the highest priority. Match the style of the existing tests (framework, fixtures, naming). Don't change production code just to make it more testable (report testability problems instead of fixing them here).

## Notes

- Don't aim for 100% coverage. Covering the important paths is enough.
- Don't pad coverage numbers by adding only snapshot tests.
- Don't duplicate at the unit-test level what's already covered by E2E tests.
