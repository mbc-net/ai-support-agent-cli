# In-Source Documentation Conventions

Building on the commenting principles in `rules/common/coding-guidelines.md`, this document defines the format and language for doc comments.

## Declaring the designated language

- Declare your documentation language in each project's CLAUDE.md, using a section like this:

  ```markdown
  ## Documentation conventions
  - Designated language: English | Japanese | Bilingual
  - Adopted conventions: list which files under rules/documentation/ this project follows (e.g., source-docs, api-docs, docs-site, test-docs)
  ```

- **If undeclared, the default is English** (adjust this default to whatever fits your project/organization).
- Public libraries and repositories with external collaborators should favor "English" or "Bilingual."
- Reviewers should only flag mismatches against the *declared* language. If you spot mixed languages in a project with no declaration, propose adding the declaration rather than flagging the mix itself.

## General principles

- Doc comments are required only for **public APIs, exported functions, and shared library code** — not for internal helpers whose name and signature are already self-explanatory.
- Required elements: a one-sentence summary, parameter descriptions, return value description, and any exceptions thrown (if applicable).
- Favor explaining "why this exists / what constraints apply" over "what it does." Don't write a comment that just restates the implementation.
- Don't repeat information the signature (type declarations) already conveys.

## Format by language

### TypeScript — TSDoc

```typescript
/**
 * Determines whether the estimate amount exceeds the approval threshold.
 *
 * @param estimate - The estimate to evaluate. Must already be finalized.
 * @param threshold - The threshold (pre-tax, in the base currency). Falls back to the system setting if omitted.
 * @returns true if the amount exceeds the threshold
 * @throws {EstimateNotFixedError} if the estimate has not been finalized
 * @see tests/services/estimateApproval.spec.ts
 */
```

- Use `@param` / `@returns` / `@throws`. Let the signature carry the type information — don't restate types in the comment.
- Use `@see` to reference related tests or functions (this also becomes a link on the documentation site).

### Python — docstrings (Google style)

```python
def calculate_invoice_total(invoice_id: int) -> Decimal:
    """Calculates the total amount for an invoice.

    Args:
        invoice_id: The target invoice ID. Must already be finalized.

    Returns:
        The tax-inclusive total amount.

    Raises:
        InvoiceNotFoundError: If the invoice does not exist.
    """
```

- Use Google style (Args / Returns / Raises) as the default. If a project already uses NumPy or reST style, follow the existing convention instead.

### PHP — PHPDoc

```php
/**
 * Confirms an order and allocates inventory for it.
 *
 * @param Order $order The order to confirm. Must be in draft status.
 * @return Order The confirmed order
 * @throws InventoryShortageException If there is insufficient inventory.
 */
```

- Omit type annotations that duplicate native type declarations (parameter and return types). Don't write a bare `@param Order $order` line with no description.

## Bilingual format

When the designated language is "Bilingual," write the primary language first, followed by the secondary language, within the same block.

```typescript
/**
 * Determines whether the estimate amount exceeds the approval threshold.
 * (secondary-language translation of the same sentence)
 */
```

- The summary is required in both languages. Parameter descriptions are required in the primary language and optional in the secondary language, to keep the maintenance burden reasonable.
