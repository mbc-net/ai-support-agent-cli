---
name: backend-patterns
description: A collection of backend design and implementation patterns covering layering, input validation, N+1 queries and transactions, caching, error handling, authentication/authorization, rate limiting, structured logging, and background jobs, for NestJS / Django / Flask / Laravel / CakePHP. Use this when designing, implementing, or reviewing backend APIs, service layers, or jobs.
---

# backend-patterns: Backend Design & Implementation Patterns

Target stacks: NestJS / Django / Flask / Laravel / CakePHP.
Code examples favor NestJS, Django, and Laravel; Flask and CakePHP equivalents are noted alongside them.
For interface conventions such as URL design and status codes, see the api-design skill.

## Layering

- Keep controllers (handlers) thin. Their only responsibilities are: accepting and transforming input, calling the service layer, and shaping the response.
- Put business logic in the service layer. Conditional branching, calculations, and cross-resource consistency all belong here.
- Keep data access isolated in a repository/ORM layer. Don't leak raw SQL or query-builder details into the service layer.
- Structuring things so the same logic can be called from both a controller and a job (CLI or queue worker) is a good self-check for whether your layering is actually sound.

```typescript
// NestJS
// Bad: business logic and data access live directly in the controller
@Post()
async create(@Body() body: any) {
  const user = await this.userRepo.findOne({ where: { email: body.email } });
  if (user) throw new BadRequestException('exists');
  if (body.plan === 'pro' && !body.cardToken) throw new BadRequestException();
  return this.userRepo.save({ ...body });
}

// Good: the controller only passes through; decisions live in the service layer
@Post()
async create(@Body() dto: CreateUserDto) {
  return this.usersService.register(dto);
}
```

In Django, keep views thin and push logic into a service module (e.g. `services.py`) or model methods. In Laravel, delegate from controllers to service/action classes, and push complex Eloquent queries into query scopes or repositories. In CakePHP, preserve the Controller → Table (model layer) separation.

## Input Validation

Use the framework's built-in validation mechanism. Hand-rolled chains of `if` statements are easy to miss cases with and hard to review.

- NestJS: DTOs + class-validator + `ValidationPipe` (always enable `whitelist: true`)
- Django: Forms / DRF Serializers
- Flask: schema validation libraries such as marshmallow or pydantic
- Laravel: FormRequest
- CakePHP: Validator (the Table's `validationDefault`)

```typescript
// NestJS
// Good: declare types and constraints via a DTO, and strip unknown fields with whitelist
export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @Length(8, 72)
  password: string;
}
// main.ts: app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
```

```python
# Django REST Framework
# Bad: passing request.data straight into the model (mass assignment)
User.objects.create(**request.data)

# Good: use a serializer to explicitly declare which fields are accepted
class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ["email", "password"]  # avoid fields = "__all__"
```

```php
// Laravel
// Bad: mass-assigning $request->all() (is_admin etc. could be overwritten)
User::create($request->all());

// Good: use only FormRequest's validated() data, and keep $fillable minimal
public function store(StoreUserRequest $request)
{
    return User::create($request->validated());
}
```

The principle behind mass-assignment protection is the same everywhere: explicitly whitelist which fields may be accepted. Attributes tied to permissions or ownership — `is_admin`, `role`, `tenant_id`, and the like — should be set from server-side context (the authenticated identity), never from the request body.

## Database

### Detecting N+1 Queries and Batching Fetches

Always be suspicious of queries issued inside a loop. During development, check actual query counts with a query log (Django Debug Toolbar, Laravel Telescope / `DB::listen`, TypeORM's `logging: true`).

```python
# Django
# Bad: fetches the author one row at a time per article (1 + N queries)
for article in Article.objects.all():
    print(article.author.name)

# Good: preload via JOIN / batch fetch
for article in Article.objects.select_related("author"):
    print(article.author.name)
# Use prefetch_related for many-to-many and reverse relations
```

```php
// Laravel
// Bad: accessing $article->author inside a loop triggers N lazy-load queries
$articles = Article::all();

// Good: eager loading fetches everything up front
$articles = Article::with('author')->get();
```

In NestJS + TypeORM, achieve the same with `relations` or `leftJoinAndSelect` on the QueryBuilder. With Prisma, use `include`.

### Transaction Boundaries

Identify the unit of work that must be "all succeed or all fail," and wrap exactly that unit in a transaction.

- Open transactions in the service layer. Opening them in a controller or in an individual repository call leaves the boundary ambiguous.
- Never put external API calls, email sending, or other long-running operations inside a transaction. Doing so extends how long locks are held, and if the external call fails and you roll back the DB, the external side effect can't be undone. Perform external effects after commit, or hand them off to a job queue.

```python
# Django
# Good: confirming an order and decrementing stock happen in one transaction
from django.db import transaction

def confirm_order(order_id: int) -> None:
    with transaction.atomic():
        order = Order.objects.select_for_update().get(pk=order_id)
        order.confirm()
        order.save()
        Stock.objects.filter(product=order.product).update(
            quantity=F("quantity") - order.quantity
        )
    # Good: send the email only after commit
    transaction.on_commit(lambda: send_order_mail.delay(order_id))
```

Laravel uses `DB::transaction(fn () => ...)`; NestJS + TypeORM uses `dataSource.transaction()` or a QueryRunner. In systems built around command/event sourcing with separate write and read models, a single command is typically the unit of consistency — don't try to force consistency across multiple aggregates into one transaction; instead, design the cross-aggregate effects as eventually-consistent follow-up processing.

## Caching

The default pattern is cache-aside: check the cache on read, and on a miss, fetch from the database and populate the cache.

```typescript
// NestJS (cache-aside skeleton)
async getProduct(id: string): Promise<Product> {
  const cached = await this.cache.get<Product>(`product:${id}`);
  if (cached) return cached;
  const product = await this.productRepo.findOneByOrFail({ id });
  await this.cache.set(`product:${id}`, product, 300); // always set a TTL
  return product;
}
```

- Design assuming invalidation is hard. Combine explicit deletion on update with a TTL as a second line of defense, and decide per data type how much staleness is acceptable until the TTL expires. Standardize keys as `resource-name:id` so you can always identify what to invalidate.
- Safe to cache: master/reference data, public content, expensive aggregate results — anything that looks the same to everyone and can tolerate some staleness.
- Do not cache (or be extremely careful with): authorization decisions, entire responses containing personal information, or values that demand strict accuracy such as balances or inventory counts. Storing user-specific data under a key that doesn't include the user ID is a classic way to leak one user's data to another — avoid it absolutely.

## Error Handling

### Centralized Handlers

Don't scatter exception handling throughout the codebase; consolidate it in the framework's centralized mechanism.

- NestJS: Exception Filter (`@Catch()`)
- Django: middleware / DRF's `EXCEPTION_HANDLER`
- Flask: `@app.errorhandler`
- Laravel: exception handling configuration in `bootstrap/app.php` (formerly the Handler class)
- CakePHP: ErrorController / a custom ExceptionRenderer

A centralized handler has three jobs: logging (including the stack trace), producing a safe, well-formed response for the client, and mapping errors to status codes.

### Preventing Internal Information Leaks

Never include stack traces, SQL, file paths, or environment variables in production error responses. Always verify `DEBUG=False` (Django) and `APP_DEBUG=false` (Laravel) in production. Return only an error code and a correlation ID (request ID) to the client; keep the details in server-side logs.

```typescript
// NestJS
// Bad: returns the raw exception message (leaks internal details)
catch (e) { throw new InternalServerErrorException(e.message); }

// Good: log the details, return only a fixed code and correlation ID to the client
catch (e) {
  this.logger.error({ requestId, err: e }, 'order confirmation failed');
  throw new InternalServerErrorException({ code: 'INTERNAL_ERROR', requestId });
}
```

### Retries with Exponential Backoff (External API Calls)

Transient external API failures (timeouts, 429s, 5xx) are worth retrying. 4xx errors (validation failures, etc.) won't succeed on retry, so fail fast instead.

```python
# Python (conceptual skeleton — in practice, use a library like tenacity)
# Good: exponential backoff + jitter, with a cap on retry attempts
import random, time

def call_with_retry(func, max_attempts=4, base=0.5):
    for attempt in range(1, max_attempts + 1):
        try:
            return func()
        except TransientError:
            if attempt == max_attempts:
                raise
            time.sleep(base * (2 ** (attempt - 1)) + random.uniform(0, 0.1))
```

Anything you retry must be idempotent. Don't casually retry a non-idempotent POST — only do so if you can attach an idempotency key. Use the silent-failure-hunter subagent to check for swallowed exceptions (`except: pass`, empty `catch` blocks).

## Authentication & Authorization

- Always enforce authorization server-side. Hiding a button or a screen on the frontend is a UX affordance, not a security control — design as if the API can be hit directly.
- Separate authentication (who you are) from authorization (what you're allowed to do). Even after authentication succeeds, check permission on the target resource for every request.
- Use each framework's declarative mechanism for role-based authorization: NestJS uses Guards + custom decorators, Django uses `permission_classes` / `@permission_required`, Laravel uses Policies/Gates, Flask uses decorators, CakePHP uses the Authorization plugin.
- Guard against IDOR (Insecure Direct Object Reference — being able to view another user's resource just by guessing its ID) by including "does the logged-in user own this" as part of the query condition, not as an afterthought check.

```php
// Laravel
// Bad: fetching by ID alone (exposes other users' orders)
$order = Order::findOrFail($id);

// Good: scope the query to the owner, then authorize via a Policy
$order = $request->user()->orders()->findOrFail($id);
$this->authorize('view', $order);
```

```typescript
// NestJS
// Good: declare the required role via a decorator and enforce it centrally with a Guard
@Roles('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Delete(':id')
remove(@Param('id') id: string) { ... }
```

In multi-tenant setups, never accept the tenant ID from the request body — derive it from the authenticated identity and enforce it on every query.

## Rate Limiting

Apply rate limiting to publicly exposed endpoints (login, sign-up, password reset, search, public APIs). This defends against both brute-force attacks and general overload.

- NestJS: `@nestjs/throttler`
- Django: DRF throttling (`AnonRateThrottle` / `ScopedRateThrottle`), django-ratelimit
- Flask: Flask-Limiter
- Laravel: the `throttle` middleware (RateLimiter)
- CakePHP: a rate-limiting plugin used as middleware
- Serverless setups: also apply throttling at the API Gateway / WAF layer

In multi-instance deployments, the rate-limit counter must live in a shared store such as Redis — otherwise per-instance counters make the limit effectively meaningless.

## Structured Logging

- Emit logs in a structured format (e.g. JSON) rather than embedding values into message strings, so they're searchable and aggregable as fields.
- Attach a request ID (correlation ID) to every log line so you can trace one request's full processing path. In NestJS, use AsyncLocalStorage (e.g. nestjs-cls); in Django/Flask, attach it via middleware.
- For the full house rules on log levels, debug-mode conventions (recording function entry/exit and inputs/outputs), and X-Ray/Sentry integration, consult your repository's own logging conventions/rules document.
- Include identifying fields (userId, orderId, etc.) as structured fields. Never log personal data or credentials — passwords, tokens, card numbers — under any circumstances.

```typescript
// NestJS (structured logger such as pino)
// Bad: no context, not searchable, doesn't say what failed
this.logger.log('failed');

// Good: correlation ID and target ID as structured fields
this.logger.warn(
  { requestId, orderId, reason: 'stock_shortage' },
  'order confirmation rejected',
);
```

How to choose a log level:

- `error`: a failure that needs a human to respond. Should trigger alerts.
- `warn`: something abnormal but self-recovered, or an expected-in-business failure (succeeded after retry, frequent validation rejections, etc.).
- `info`: business-event milestones (order confirmed, job completed).
- `debug`: development-time detail. Disabled by default in production.

Avoid letting your level scheme collapse — e.g. logging normal operation at `error`, or swallowing an exception while logging it at `info`.

## Background Jobs

- Use a durable queue backend: BullMQ (Redis), Celery (Redis / RabbitMQ), Laravel Queue (Redis / SQS / database), SQS, and similar. In-process queues — an in-memory array, chained `setTimeout` calls, or Laravel's `sync` driver in production — are not acceptable; jobs vanish on process restart or deploy.
- Design jobs to be idempotent. Queues generally guarantee at-least-once delivery, so the same job may run twice — make sure that doesn't corrupt results. Absorb duplicate execution with a "already processed" flag, a uniqueness constraint, or an idempotency key.

```python
# Celery
# Bad: running this twice double-charges the customer
@shared_task
def charge(order_id):
    api.charge(amount=get_order(order_id).total)

# Good: a processed-check plus an idempotency key make double execution harmless
@shared_task(bind=True, max_retries=5)
def charge(self, order_id):
    order = get_order(order_id)
    if order.charged:
        return
    api.charge(amount=order.total, idempotency_key=f"charge-{order_id}")
    order.mark_charged()
```

- Always design for the failure path: cap the retry count, use exponential backoff, and on exhausting retries, route the job to a dead-letter queue (DLQ) or a failure table (Laravel's `failed_jobs`) with a notification. Never let a failure disappear silently.
- Pass an ID into the job, not the full entity, and re-fetch the latest state at execution time — this avoids acting on stale data that sat in the queue for a while.

## Related Commands & Subagents

- During the design phase, use `/plan` to nail down the implementation approach before starting.
- After implementation, request review from `/code-review` and code-reviewer subagents.
- Use the silent-failure-hunter subagent to check for swallowed exceptions and silently discarded errors.
