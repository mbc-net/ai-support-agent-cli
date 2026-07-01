# Documentation Site Conventions (Docusaurus / i18n)

The documentation site standardizes on Docusaurus and supports switching between locales. For concrete build and integration steps and templates, see the docs-site skill. This document defines what must be upheld.

## i18n (multiple languages)

- Support exactly two locales: a **default** locale and a secondary locale (e.g., `en` as default, `ja` as secondary — pick and declare the pairing per project).
- **Hand-written guides and conceptual pages must exist in both locales.** Any PR that updates the source-language page must also update the translation.
- If a translation unavoidably lags behind, add an "untranslated" notice at the top of the translated page (including the date the source was last updated). This notice is something the update-docs workflow should detect.
- Auto-generated reference pages (see below) only need to exist in the default locale — this is a deliberate decision to keep translation-sync costs down.

## Page categories and generation method

| Page type | Method | i18n |
|---|---|---|
| Guides, concepts, tutorials | Hand-written | Both languages required |
| NestJS API reference | Auto-generated from OpenAPI (no hand-transcription) | Default locale only |
| TypeScript library function reference | Recommended: auto-generated from TypeDoc | Default locale only |
| Python / PHP function reference | Hand-written from a template, with a consistency check | Default locale only |

## Sidebar organization (structuring the function list)

- Organize function references in the sidebar as a **category (module / functional area) → function name** hierarchy.
- Auto-generated pages use the sidebar the plugin outputs; hand-written pages must always be registered in the category definitions in `sidebars.js` — never leave a page unregistered (i.e., undiscoverable from the index).
- Order categories by usage frequency and learning path, not mechanically by alphabetical order.

## Required sections on a function detail page (the canonical template)

Whether hand-written or auto-generated, every function detail page must include:

1. **Overview** — 1–3 sentences on what the function is for.
2. **Signature** — the declaration, matching the implementation exactly.
3. **Parameters table** — name / type / required / description (**name and required-ness must match the implementation character-for-character**).
4. **Output (return value)** — type and content, including how it varies by condition if applicable.
5. **Errors** — exceptions thrown or error codes returned, and the condition that triggers each.
6. **Usage example** — a minimal, working code snippet.
7. **Tests** — a link to the relevant test file (optional but recommended).

## Keeping docs in sync with source (verification convention for transcribed content)

- **Hand-written reference pages must include a `source` key in frontmatter.**

  ```yaml
  ---
  source: src/services/estimateApproval.ts#requiresDirectorApproval
  ---
  ```

- `source` is the machine-readable anchor for consistency checking. The update-docs workflow uses this key as a starting point to read the implementation and verify:
  - **Incorrect** function or parameter names (mismatched against the implementation)
  - **Missing** parameters or error entries (present in the implementation but absent from the page)
  - **Stale leftovers** (present on the page but removed from the implementation)
- The page must always describe the implementation **as it actually behaves**. If you believe the implementation itself is wrong, propose fixing the implementation — don't just edit the page to match a mistake.

## Linking to tests

- Use **repository-absolute URLs anchored to the default branch** (e.g., `https://github.com/<org>/<repo>/blob/main/src/services/estimateApproval.spec.ts`).
- Don't use commit-SHA-pinned links — they're costly to maintain and inevitably go stale.
- For linking from auto-generated TypeDoc pages, use the TSDoc `@see` tag.
- The update-docs workflow verifies that linked files exist.
