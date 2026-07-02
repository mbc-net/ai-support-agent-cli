# Python Coding Rules

For language-agnostic rules, see `rules/common/coding-guidelines.md`. This document covers only Python-specific rules.

## Type hints and syntax

- Add type hints to public functions. Reserve `Any` for receiving data at external boundaries — narrow it to a concrete type internally.
- Make optionality explicit with `X | None` (3.10+) or `Optional[X]`.
- Mutable default arguments (`def f(items=[])`) are forbidden. Default to `None` and construct the value inside the function.
- Never compare against `None` with `==`. Use `is None` / `is not None`.
- Don't shadow builtin names (`list`, `dict`, `id`, `type`).
- Leave formatting and import ordering to ruff / black — don't debate them in review.

## Error handling

- Bare `except:` and `except Exception: pass` are forbidden. Catch specific exceptions and handle them (log and propagate, retry, or notify).
- Manage files, connections, and locks with `with` (context managers).
- When re-raising, preserve the cause with `raise ... from e`.

## Django

- Always use `select_related` (FK/OneToOne) or `prefetch_related` (M2M/reverse relations) when accessing related objects in a loop.
- Never do a read-increment-save cycle for counters; update atomically with an `F()` expression.
- Wrap multiple writes in `transaction.atomic()`.
- Every model change needs a migration; drop columns via a two-phase deploy (make nullable → remove references → drop the column in a later release).
- DRF: `fields = '__all__'` on a Serializer is forbidden. List fields explicitly and set `read_only_fields`. List endpoints must be paginated.
- Use `save(update_fields=[...])` for partial updates so you don't clobber concurrent writes.
- Don't use signals for intra-app model-to-model coordination; prefer explicit calls from the service layer.

## Flask

- Use the application factory pattern (`create_app()`). Don't instantiate `app` at module level.
- Split routes into feature-scoped Blueprints.
- Validate `request.json` / `request.args` with marshmallow or pydantic before use.
- Keep request-scoped state in `g` and configuration in `app.config`. Don't share state through mutable module-level globals.
- Ensure `db.session.commit()` failures trigger a `rollback()` (via try/except/finally or a teardown handler).

## Documentation

- For docstring format (Google style) and comment language, see `rules/documentation/`.
