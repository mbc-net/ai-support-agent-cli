# Test Documentation Conventions

Tests are a specification. The goal is that reading the list of test names alone gives you a list of the spec's requirements, and reading a test's body gives you the detail (what it covers and why).

## Writing describe / it blocks

- **describe**: names the subject under test (class, function, or endpoint). Use nested describes to represent different scenarios ("when inventory is insufficient," "when the user has admin privileges").
- **it / test**: write a **complete specification sentence that includes an observable outcome**, in the project's designated language.

```typescript
describe('EstimateApprovalService.approve', () => {
  describe('when the estimate amount exceeds $10,000', () => {
    it('does not become approved until director approval is complete', () => { ... });
    it('throws PendingDirectorApprovalError when only the manager has approved', () => { ... });
  });
});
```

- Forbidden names: uninformative labels like "happy path," "error case 1," "test1," "works," "OK" — anything that doesn't convey the spec on its own.
- **Whatever outcome the test name claims must actually be asserted in the body.** A name like "throws an exception" with no assertion verifying the exception is a mismatch that the update-docs workflow and code review should catch.

## Structuring the test body

- Separate Arrange / Act / Assert with blank lines so the flow is easy to follow.
- For complex setup, add a comment explaining what scenario is being constructed.
- Annotate meaningful test data with its rationale (e.g., `1_000_001 // one above the $10,000 threshold boundary`). Don't annotate values that have no particular significance.

## Conventions by stack

| Stack | Test naming | Notes |
|---|---|---|
| Jest / Vitest / Playwright | describe + it (as above) | Nest with `test.describe` where helpful |
| pytest | Test function name (e.g., `test_requires_director_approval_above_threshold`, in the designated language if appropriate) | For complex cases, put the summary and intent in a docstring |
| PHPUnit | Test method name | The `@testdox` annotation can spell out the spec sentence; `#[TestDox('throws an exception when inventory is insufficient')]` is recommended |

## Scope of application

- All new tests must follow this convention.
- Rename existing tests opportunistically, as part of a change that already touches them — a rename-only bulk change isn't worth the review cost on its own.
