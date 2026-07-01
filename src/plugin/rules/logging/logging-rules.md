# Logging Conventions

Goal: make it possible for both humans and AI to complete debugging **by reading only the source comments and the logs**. The standard is that logs alone should let you reconstruct "which user's, which request's, which function, with what input, passed through and failed where."

## Adoption and cost tuning

- Projects adopting this convention should add `logging` to the "adopted conventions" list in the "## Documentation conventions" section of their CLAUDE.md.
- Log volume translates directly into cost, so **control output level via an environment variable** and tune it per project (typical default: INFO in production, DEBUG in development/investigation as a debug mode).
- For high-traffic code paths, consider sampling DEBUG output (emit only a fraction of events). Document any such tuning in CLAUDE.md.

## Basics

- **Structured logging (JSON) is the standard.** Emit a `message` plus fields — don't embed information via string concatenation.
- Field names are **full English words in snake_case, never abbreviated** (`request_id`, not `req_id`; `user_id`, not `uid`; also `duration_ms`, `function_name`).
- Write messages in the project's designated language (same as the documentation convention; default to English if undeclared). Field names are always in English.

### Choosing a log level

| Level | Use |
|---|---|
| ERROR | A failure that requires action. Always include the exception, correlation ID, and the ID of the affected resource. |
| WARN | An anomaly that self-recovered, a retry, approaching a threshold — anything worth monitoring. |
| INFO | Business events (start/completion of order confirmation, invoice issuance, etc.; state transitions). The standard production level. |
| DEBUG | For investigation: function start/end, inputs/outputs, and the data behind branching decisions. |

## Correlation IDs (end-to-end tracing)

To let you trace all logs from a single request across the system, **attach the following to every log entry automatically** — never pass them manually at each call site.

- `request_id`: capture the `X-Request-Id` header at the request entry point (generate one if absent), set it in the logging context, and echo it back in the response header.
- `user_id` (set after authentication), `tenant_code` (in multi-tenant systems, also useful for verifying tenant isolation).
- `trace_id`: if you have AWS X-Ray (or an equivalent tracing system) enabled, include the trace ID as well, so logs and traces can be cross-referenced (for Lambda, enabling active tracing propagates the header automatically).
- **Propagation into async work**: when enqueuing a job, include `request_id` in the message and restore it into the logging context on the worker side. For batch-originated processing, generate a `job_id` per execution unit.

### Implementing context propagation, by stack

| Stack | Implementation |
|---|---|
| NestJS | nestjs-pino + AsyncLocalStorage (set request_id / user_id in middleware). On Lambda, AWS Lambda Powertools Logger + `injectLambdaContext`. |
| Django / Flask | structlog + contextvars. Bind in middleware; propagate to Celery etc. via headers. |
| Laravel | Set Log Context (`Context::add()`) in middleware. Propagate to queued jobs via Context dehydration. |
| CakePHP | Attach common fields via a Monolog Processor. |

## Debug mode (DEBUG level)

- **Log the start and end of each function**: `function_name`, the input (INPUT) at start, and the output (OUTPUT) plus `duration_ms` at end.
- Apply this to public methods in the service/use-case layer by default; skip trivial getters and one-line utilities.
- Don't scatter this by hand — implement it cross-cuttingly (decorators, interceptors, etc.).

```typescript
// NestJS example: a method decorator that logs start/end/input/output at DEBUG level
@LogExecution() // implementation lives in a shared project library
async approveEstimate(input: ApproveEstimateInput): Promise<EstimateResult> { ... }
// DEBUG: {"message":"function start","function_name":"approveEstimate","input":{...},"request_id":"..."}
// DEBUG: {"message":"function end","function_name":"approveEstimate","output":{...},"duration_ms":42,"request_id":"..."}
```

### Masking (required even at DEBUG level)

- Never log passwords, tokens, API keys, or personal information (name, email, address, etc., per your project's definition) — **even at DEBUG level**. Route these through a shared masking function.
- Truncate large payloads (file contents, large arrays) down to a count/size summary.

## Recording errors

- Every ERROR log must include: the exception object (with stack trace), `request_id`, the ID of the affected resource (e.g., `order_id`), and what operation was being attempted.
- **If the project uses Sentry, capture unhandled exceptions there too.**
  - Send them via a single global exception handler (a NestJS exception filter, or the equivalent in Django/Laravel) rather than manually capturing at each call site. (Rule of thumb: only manually capture "handled" exceptions — ones that don't propagate to the caller — when they're operationally worth knowing about.)
  - Set `request_id` / `user_id` as Sentry tags/context so they can be cross-referenced with logs and traces.
  - Don't report exceptions that were caught and handled as part of normal flow — that's just noise and duplicate alerting.
- The discipline of error handling itself (never swallow, preserve the cause) follows the standards in rules/common and the silent-failure-hunter criteria.

## Checklist: logs an AI can debug from

Confirm new feature logging design satisfies the following:

- [ ] Every log for a given request (including async work) can be retrieved by `request_id`.
- [ ] The retrieved logs alone reveal the order of functions traversed and their inputs/outputs (at DEBUG level).
- [ ] On failure, the ERROR log has everything: where it happened, what was being attempted, what went wrong, and what resource was affected.
- [ ] Read together with the source comments (constraints, intent), you can form a root-cause hypothesis without running the code.

## Naming and clarity (a prerequisite shared with logging)

Readable logs depend on readable naming in the implementation. Follow the naming rules in `rules/common/coding-guidelines.md` (**avoid abbreviations, use full English words; name functions so they read as a sentence describing what they do**). Ideally, `function_name` alone should read like a spec.
