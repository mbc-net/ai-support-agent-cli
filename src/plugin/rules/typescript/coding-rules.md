# TypeScript Coding Rules

For language-agnostic rules, see `rules/common/coding-guidelines.md`. This document covers only TypeScript-specific rules.

## Types

- Assume `strict: true`. Any change that weakens tsconfig strictness needs justification in review.
- `any` is forbidden as a rule. Receive external data as `unknown` and narrow it. If you must use `any`, comment why.
- Give public/exported functions an explicit return type.
- Prefer type guards and early returns over the non-null assertion (`value!`).
- Don't silence a type error with an `as` cast — if a cast feels necessary, fix the type definition instead.
- Consider type aliases or branded types for domain values (avoid parameter lists that are all bare `string`).

## Asynchronous code

- Always `await` a Promise, or mark an intentional fire-and-forget with a `void` prefix and a comment explaining why.
- `array.forEach(async ...)` is forbidden. Use `for...of` (sequential) or `Promise.all` (parallel).
- Don't sequentially `await` independent async operations — batch anything that can run in parallel with `Promise.all`.
- Set a timeout on external calls via `AbortController` or client configuration.

## Modules and syntax

- Default to `const`; use `let` only when reassignment is required. Never use `var`.
- Use only `===` / `!==` for equality comparisons.
- Prefer a union type (`type Status = 'active' | 'inactive'`) or `as const` over `enum`.
- Don't overuse barrel files (re-exporting everything through `index.ts`) — they cause circular imports and bundle bloat.

## NestJS

- Always receive input through a DTO with class-validator decorators. Set `whitelist: true` on the global `ValidationPipe`.
- Explicitly attach a Guard (authentication + authorization) to protected routes. Any use of `@Public()` needs justification in review.
- Direct access to `process.env` is forbidden. Use `ConfigService` with startup-time schema validation.
- If you find yourself needing `forwardRef()`, treat it as a signal to revisit the design (extract a shared module, or move to an event-driven approach instead).
- Convert exceptions via `HttpException` subclasses or an exception filter — never leak internal details into the response.

## Next.js

- Place `"use client"` close to the interactive leaf component that needs it — not at the top of a page or layout.
- Treat Server Actions and Route Handlers as public endpoints: check the session, authorize, and validate the schema at the top of each one.
- Never put secrets in `NEXT_PUBLIC_*` variables.
- Use `next/image` for content images and `next/link` for internal navigation.

## Documentation

- For TSDoc format, comment language, and the OpenAPI workflow (NestJS → Next.js type generation), see `rules/documentation/`.
