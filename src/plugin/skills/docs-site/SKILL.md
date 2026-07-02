---
name: docs-site
description: A pattern library for building and operating a documentation site with Docusaurus. Covers i18n (ja/en) structure, automatic OpenAPI generation from NestJS, wiring OpenAPI/TypeDoc output into Docusaurus, type and client generation with openapi-typescript / orval, templates for hand-written reference pages, and CI freshness checks. Use this when setting up a new documentation site, adding pages, updating API references, syncing translations, or building a type-generation pipeline.
---

# docs-site: Docusaurus documentation site patterns

This skill is a pattern library focused on "how to build it." The authoritative source for the conventions themselves lives in `rules/documentation/` (aimed at repository maintainers); this skill assumes those conventions are already settled and provides the implementation steps.

## Baseline conventions assumed here

- Locales are `ja` (default) + `en`. Hand-written guides must exist in both languages. Auto-generated reference pages exist only in the default locale.
- NestJS APIs are documented by auto-generating from OpenAPI (hand-transcribing is not allowed). For TS libraries, prefer TypeDoc auto-generation. Python / PHP are handled with hand-written templates plus a consistency check.
- Hand-written reference pages must include a `source: src/path/file.ts#functionName` key in the frontmatter.
- Links to tests use a repository-absolute URL anchored to the default branch (never pin to a commit SHA).

## 1. Basic Docusaurus i18n setup

### docusaurus.config.js

```js
// docusaurus.config.js (excerpt)
module.exports = {
  title: 'Docs',
  url: 'https://docs.example.com',
  baseUrl: '/',
  i18n: {
    defaultLocale: 'ja',          // default locale is ja
    locales: ['ja', 'en'],
  },
  themeConfig: {
    navbar: {
      // always include a locale-switcher dropdown
      items: [{ type: 'localeDropdown', position: 'right' }],
    },
  },
};
```

### Directory structure

The source-of-truth content for the default locale (ja) lives under `docs/`, and the en translation mirrors the same structure under `i18n/en/`.

```text
docs/
  guides/getting-started.md        # ja original (source of truth)
i18n/
  en/
    docusaurus-plugin-content-docs/
      current/
        guides/getting-started.md  # en translation (same relative path as docs/)
    code.json                      # translations for UI strings
```

### Translation workflow

```bash
# 1. Generate translation files for UI strings / sidebar labels (for en)
npm run write-translations -- --locale en

# 2. Place the en translation of a hand-written guide under i18n/en/.../current/
#    at the same relative path, then translate it
cp docs/guides/getting-started.md \
   i18n/en/docusaurus-plugin-content-docs/current/guides/getting-started.md

# 3. Run the dev server per locale to check it (dev server serves one locale at a time)
npm run start -- --locale en

# 4. A production build verifies all locales together
npm run build
```

Whenever the original (ja) content is updated, update the en translation in the same PR. Auto-generated reference pages (from OpenAPI / TypeDoc) exist only in the default locale — do not copy them into `i18n/en/`.

## 2. Generating OpenAPI output from NestJS

Prepare a generation-only script that doesn't depend on the server actually listening. It's important that this can run in CI without opening a port.

```ts
// scripts/generate-openapi.ts
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'fs';
import { AppModule } from '../src/app.module';

async function generate() {
  // Build only the application context, without calling listen()
  const app = await NestFactory.create(AppModule, { logger: false });

  const config = new DocumentBuilder()
    .setTitle('API').setVersion('1.0.0').addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  writeFileSync('openapi.json', JSON.stringify(document, null, 2));

  await app.close();
}

generate();
```

```jsonc
// package.json (excerpt)
{ "scripts": { "openapi:generate": "ts-node scripts/generate-openapi.ts" } }
```

Enabling the `@nestjs/swagger` CLI plugin lets it auto-infer `@ApiProperty` from DTO properties, which reduces missing-decorator mistakes.

```jsonc
// nest-cli.json
{
  "sourceRoot": "src",
  "compilerOptions": {
    "plugins": [
      { "name": "@nestjs/swagger", "options": { "introspectComments": true } }
    ]
  }
}
```

## 3. Pulling OpenAPI into Docusaurus

Use `docusaurus-plugin-openapi-docs` to generate MDX pages from `openapi.json`.

```js
// docusaurus.config.js (excerpt)
module.exports = {
  plugins: [
    [
      'docusaurus-plugin-openapi-docs',
      {
        id: 'api',
        docsPluginId: 'classic',
        config: {
          myApi: {
            specPath: 'openapi.json',          // the generated spec
            outputDir: 'docs/api',             // output location (default locale only)
            sidebarOptions: {
              groupPathsBy: 'tag',             // group by tag
              categoryLinkSource: 'tag',
            },
          },
        },
      },
    ],
  ],
  themes: ['docusaurus-theme-openapi-docs'],
};
```

```js
// sidebars.js (excerpt): pull in the generated sidebar
module.exports = {
  docs: [
    { type: 'category', label: 'Guides', items: [{ type: 'autogenerated', dirName: 'guides' }] },
    { type: 'category', label: 'API Reference', items: require('./docs/api/sidebar.js') },
  ],
};
```

```bash
# Regenerate (run this every time the API changes; clear old pages before rebuilding)
npm run openapi:generate                      # in the API repository
npx docusaurus clean-api-docs myApi           # remove existing generated output
npx docusaurus gen-api-docs myApi             # regenerate
```

The generated `docs/api/` content is served only in the default locale (the ja site) — do not create a translated copy under `i18n/en/`, and do not hand-edit it.

## 4. Generating Next.js types and clients from OpenAPI

Use `openapi-typescript` if you only need types, or `orval` if you also want a fetch client. In both cases, standardize the output location as `src/generated/`.

```jsonc
// package.json (excerpt): generate types only
{ "scripts": { "codegen:types": "openapi-typescript ../api/openapi.json -o src/generated/api-types.ts" } }
```

```ts
// orval.config.ts: generate both types and client
import { defineConfig } from 'orval';

export default defineConfig({
  myApi: {
    input: '../api/openapi.json',
    output: {
      target: 'src/generated/api-client.ts',
      client: 'fetch',               // use 'react-query' if you're using React Query
      clean: true,                   // remove stale files on regeneration
    },
  },
});
```

Enforce the "no hand-editing" rule with a two-pronged approach: exclude generated files from lint, and detect regeneration drift in CI (see section 7).

```jsonc
// .eslintrc.json (excerpt): don't lint generated output — this signals it isn't meant to be hand-edited
{
  "ignorePatterns": ["src/generated/**"]
}
```

`src/generated/` should still be committed (so reviewers can see the diff), but a PR containing manual edits to it will fail the CI freshness check.

## 5. Pulling TypeDoc into Docusaurus

```js
// docusaurus.config.js (excerpt)
module.exports = {
  plugins: [
    [
      'docusaurus-plugin-typedoc',
      {
        entryPoints: ['../packages/sdk/src/index.ts'],
        tsconfig: '../packages/sdk/tsconfig.json',
        out: 'docs/sdk',              // output location (default locale only)
        sidebar: { autoConfiguration: true },
      },
    ],
  ],
};
```

```js
// sidebars.js (excerpt): pull in the sidebar generated by TypeDoc
module.exports = {
  docs: [
    { type: 'category', label: 'SDK Reference', items: require('./docs/sdk/typedoc-sidebar.cjs') },
  ],
};
```

Embed links to tests via `@see` in TSDoc comments. Links should use an absolute URL anchored to the default branch (never pin to a SHA).

```ts
/**
 * Calculates the order total including tax.
 * @param items - array of order line items
 * @see {@link https://github.com/example-org/sdk/blob/main/test/order.spec.ts | order.spec.ts test cases}
 */
export function calcOrderTotal(items: OrderItem[]): number { /* ... */ }
```

## 6. Full template for a hand-written function reference

For languages such as Python / PHP where auto-generation isn't available. The `source` frontmatter key is required so the consistency check (`/update-docs`) can trace back to the implementation.

```markdown
---
id: calc-order-total
title: calc_order_total
source: src/services/order.py#calc_order_total
---

## Overview

Calculates the tax-inclusive total from an array of order line items.

## Signature

\`\`\`python
def calc_order_total(items: list[OrderItem], tax_rate: Decimal = Decimal("0.10")) -> int
\`\`\`

## Parameters

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| items | list[OrderItem] | Yes | Array of order line items. An empty array is allowed |
| tax_rate | Decimal | No | Tax rate. Defaults to 0.10 |

## Output

The tax-inclusive total (in yen, as an int). Returns 0 for an empty array.

## Errors

| Exception | Code | Condition |
| --- | --- | --- |
| ValueError | E_NEGATIVE_PRICE | A line item has a negative unit price |
| ValueError | E_INVALID_TAX_RATE | tax_rate is less than 0 or greater than or equal to 1 |

## Example

\`\`\`python
total = calc_order_total(items, tax_rate=Decimal("0.10"))  # => 1100
\`\`\`

## Tests

- [tests/services/test_order.py](https://github.com/example-org/shop-api/blob/main/tests/services/test_order.py)
```

As with hand-written guides, this kind of reference page should also be prepared in both ja and en. When the implementation changes, use the `source` key as the anchor for finding and updating the corresponding page.

## 7. Example CI freshness check implementation

The principle is: "regenerate it, and fail if there's a diff." Apply this to both `openapi.json` and the generated client.

```yaml
# .github/workflows/docs-freshness.yml
name: docs-freshness
on: [pull_request]

jobs:
  freshness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      # Regenerate openapi.json and check it matches what's committed
      - run: npm run openapi:generate
      - run: git diff --exit-code openapi.json
      # Regenerate the client/types and check src/generated/ has no diff
      - run: npm run codegen:types && npx orval
      - run: git diff --exit-code src/generated/
```

The same idea applies in GitLab CI — just line up "regenerate → `git diff --exit-code`" as script steps in the job.

This check catches both failure modes: (a) a PR that changed the API but forgot to update `openapi.json`, and (b) a PR that hand-edited generated output.

## 8. Anti-patterns

| Anti-pattern | Problem | Do this instead |
| --- | --- | --- |
| Hand-writing API response types | Falls out of sync with API changes; types and reality drift apart | Generate into `src/generated/` with openapi-typescript / orval |
| Hand-editing generated output (`docs/api`, `src/generated/`) | Gets wiped out on the next regeneration, and fails the CI freshness check anyway | Edit the source of truth (decorators, TSDoc, the spec) and regenerate |
| Test links pinned to a commit SHA | Keeps pointing at old code and drifts from the current state | Use an absolute URL anchored to the default branch |
| Leaving translations behind (only updating the ja original) | English readers keep seeing stale information | Update ja and en together in the same PR for hand-written guides |
| Orphan pages missing from the sidebar | Unreachable except via search; nobody knows they exist | Always register pages in sidebars.js (either autogenerated or explicit) |

## Related

- Source of truth for conventions: `rules/documentation/` (for repository maintainers)
- API design guidance itself: the api-design skill
- Running the implementation/documentation consistency check: `/update-docs`
