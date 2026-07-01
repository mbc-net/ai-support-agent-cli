# PHP Coding Rules

For language-agnostic rules, see `rules/common/coding-guidelines.md`. This document covers only PHP-specific rules.

## Language and types

- Add `declare(strict_types=1)` to every new file (except views such as Blade templates).
- Declare parameter and return types on public methods. Reserve `mixed` for cases that genuinely can't be expressed as a union type.
- Mark constructor-promoted properties `readonly` when they're never reassigned.
- Leave formatting to Pint / PHP CS Fixer (PSR-12) — don't debate formatting in review.
- Never commit `var_dump()` / `dd()` / `dump()` calls.

## Error handling

- Empty `catch (\Exception $e) {}` blocks are forbidden. Log the error and handle it (propagate, retry, notify).
- When re-throwing, preserve the cause: `throw new XxxException('...', previous: $e)`.
- Don't ignore the return value of APIs that return `false` on failure (e.g., `save()`).

## Laravel

- Define `$fillable` on every model. `$guarded = []` is forbidden.
- Don't pass `$request->all()` directly into a save. Define a FormRequest and use `$request->validated()`; implement `authorize()` too.
- Use `with()` / `load()` for eager loading whenever you access a relation in a loop.
- Any user input passed into `DB::raw()` / `whereRaw()` must use parameter binding.
- Never use Blade's `{!! !!}` on user-supplied data. If you must, comment the sanitization rationale.
- Implement `failed()` on queued jobs and configure `$tries` / `$backoff`. Write jobs to be idempotent.
- Authorize via `auth` middleware plus `Gate` / `Policy` — don't rely on hiding UI elements alone.
- Define `$casts` for date, JSON, and boolean columns.

## CakePHP

- Never set `'*' => true` in an Entity's `$_accessible`. Explicitly list which fields allow mass assignment.
- Use `contain()` when accessing related data in a loop.
- Use `validationDefault()` for input format validation, and `buildRules()` for domain rules like uniqueness/existence checks — keep the two separate.
- Always check the return value of `save()`.
- Never interpolate variables directly into query conditions (`"field = '$value'"`). Use array conditions or parameter binding instead.

## Documentation

- For PHPDoc format and comment language, see `rules/documentation/`.
