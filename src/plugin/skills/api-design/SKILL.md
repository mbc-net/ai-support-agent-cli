---
name: api-design
description: A pattern library for REST API design. Provides guidance on resource naming, choosing HTTP methods and status codes, error response formats, pagination, versioning, idempotency, authentication/authorization, and rate limiting. Use this when designing endpoints for a new API, reviewing the design of an existing API, or when you need decision criteria for a discussion about API conventions.
---

# REST API Design Patterns

A collection of decision criteria and patterns for designing and implementing REST APIs. Reference this skill when adding new endpoints, revising an existing API, or doing a design review. Implementation examples favor NestJS, Django REST Framework, and Laravel.

This skill covers HTTP interface design — formats and conventions. For server-side implementation details of authorization, rate limiting, and error handling, see the backend-patterns skill.

## 1. Resource Design and Naming

### Basic Principles

- Represent resources as **plural nouns**. Don't use verbs.
  - Good: `GET /users`, `POST /orders`, `GET /users/123`
  - Bad: `GET /getUsers`, `POST /createOrder`
- Use lowercase kebab-case for paths (`/purchase-orders`). For query parameters, pick either snake_case or camelCase and stay consistent within the project.
- Represent IDs as path segments: `/users/{userId}`

### Nesting Depth

Keep nesting to **at most two levels** (two resources).

```
GET /users/123/orders                 # Acceptable: a user's orders
GET /users/123/orders/456/items/789   # Avoid: too deep
GET /order-items/789                  # Preferred: reference directly if the ID is unique
```

If a child resource can be uniquely identified without its parent, promote it to a top-level resource. Reserve nesting for expressing "belongs-to" relationships and narrowing list results.

### Expressing Relationships

- Express a relationship lookup either as a sub-resource (`/users/123/orders`) or as a filter (`/orders?user_id=123`). If you offer both, make sure their behavior matches.
- Express many-to-many association/disassociation as POST/DELETE on a sub-resource.

```
POST   /articles/10/tags        # body: {"tag_id": 5} to attach a tag
DELETE /articles/10/tags/5      # remove a tag
```

- Keep embedded related data in responses to the bare minimum (roughly an ID and a display name), or only expand it when explicitly requested (e.g. via `?include=`). Embedding deep relations unconditionally is a common source of N+1 queries and bloated payloads.

## 2. HTTP Methods and Status Codes

### Choosing a Method

| Method | Purpose | Idempotent |
|---|---|---|
| GET | Retrieval. Must not have side effects | Yes |
| POST | Create, or execute a non-idempotent action | No |
| PUT | Replace the entire resource | Yes |
| PATCH | Partial update | Not guaranteed (depends on design) |
| DELETE | Delete | Yes |

### When to Use Each Status Code

- **200 OK**: Successful retrieval or update. Response body present.
- **201 Created**: Successful creation. It's good practice to return the new resource's URL in the `Location` header.
- **204 No Content**: Success with no body. The standard response for a successful DELETE.
- **400 Bad Request**: The request is malformed syntactically (broken JSON, missing required parameters, etc.).
- **401 Unauthorized**: Not authenticated. Token missing, invalid, or expired.
- **403 Forbidden**: Authenticated, but not authorized for this action.
- **404 Not Found**: The resource doesn't exist.
- **409 Conflict**: A state conflict — unique constraint violation, optimistic lock failure, an operation that's already been processed, etc.
- **422 Unprocessable Entity**: Well-formed but semantically invalid (validation error). Decide once, per project, how you split this from 400.
- **500 Internal Server Error**: An unexpected server-side error. Log the details; never return them to the client.

### Choosing Between 404 and 403

Return 404 when you don't want an unauthorized user to even know the resource exists (e.g. another tenant's data, an unpublished draft). Return 403 when the resource's existence is public knowledge and only the action is forbidden (e.g. no edit permission on a published article). The deciding question is: "would revealing existence itself be a data leak?" In multi-tenant APIs, default to 404.

## 3. Error Responses

### Use One Consistent Shape

Return the same error structure from every endpoint. At minimum, include a code, a message, and details.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "There were errors in your input.",
    "details": [
      { "field": "email", "code": "invalid_format", "message": "Email address format is invalid." },
      { "field": "age", "code": "out_of_range", "message": "Must be between 0 and 150." }
    ]
  }
}
```

- `code` should be a machine-readable constant string. Clients should branch on the code, not on the message text.
- Return validation errors **per field** in a `details` array, so forms can display errors next to each field.
- Aligning with RFC 9457 (Problem Details, `application/problem+json`) is also a solid choice. Either way, standardize on one shape.

### Don't Leak Internal Information

- Never include stack traces, raw SQL, file paths, or a library's raw exception message in a response.
- For 5xx errors, return only a generic message and a correlation ID (request ID); log the details server-side.
- On authentication failure, don't distinguish between "user doesn't exist" and "wrong password" in the response.

### Implementation Example (NestJS)

```typescript
// An exception filter that converts all errors into the common shape
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json({ error: this.toErrorBody(exception) });
      return;
    }
    // Unexpected exception: log the details, return a generic message to the client
    this.logger.error(exception);
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'An internal server error occurred.' },
    });
  }
}
```

In Django REST Framework, point the `EXCEPTION_HANDLER` setting at a custom handler that repacks `ValidationError.detail` into the common shape. In Laravel, customize `render` via `withExceptions` in `bootstrap/app.php` (or the exception Handler).

## 4. Pagination

### Choosing a Strategy

- **Offset-based** (`?page=2&per_page=20` / `?offset=20&limit=20`)
  - Well suited to page-number UIs. Simple to implement.
  - Downsides: gets slow at large offsets. Inserts/deletes mid-list cause duplicates or gaps.
- **Cursor-based** (`?cursor=eyJpZCI6MTIzfQ&limit=20`)
  - Well suited to infinite scroll, frequently-updated lists, and large datasets.
  - The cursor encodes an opaque key that uniquely identifies the last row returned (e.g. `created_at` + `id`).

Decision rule: if you need a total-count display and arbitrary page jumps, use offset-based. If the dataset is large, updated frequently, or performance-sensitive, use cursor-based.

### Enforce a Limit Ceiling

The server must **always enforce an upper bound** on `limit`/`per_page` (e.g. default 20, max 100). Never use the client-supplied value as-is.

```python
# Django REST Framework
class StandardPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = "per_page"
    max_page_size = 100  # requests above this are clamped to 100
```

Include metadata in the response: for offset-based, `total` / `page` / `per_page`; for cursor-based, `next_cursor` (null when there's no next page).

## 5. Filtering, Sorting, and Search

- Express filters as query parameters: `GET /orders?status=shipped&user_id=123`
- Standardize a suffix convention for range conditions and stick to it: `?created_at_gte=2026-01-01&created_at_lt=2026-02-01` (or a `?created_at[gte]=...` style — pick one).
- For sorting, a comma-separated list with a `-` prefix for descending order is concise: `?sort=-created_at,name`.
- Route full-text/fuzzy search through `?q=keyword`, kept separate from structured filters.
- Enforce an **allowlist**. The server must explicitly enumerate which fields are filterable/sortable, and must never accept an arbitrary column name (this prevents SQL injection and unintended index scans).

```php
// Laravel: restrict sortable fields with an allowlist
$sortable = ['created_at', 'name', 'price'];
$sort = $request->query('sort', '-created_at');
$direction = str_starts_with($sort, '-') ? 'desc' : 'asc';
$column = ltrim($sort, '-');
abort_unless(in_array($column, $sortable, true), 400);
$query->orderBy($column, $direction);
```

## 6. Versioning

### Policy

**Prefer URL-path versioning (`/v1/users`).** It's explicit, and it's easy to work with in routing, logging, caching, and documentation alike.

Options and decision criteria:

| Approach | Example | Characteristics |
|---|---|---|
| URL path | `/v1/users` | Most explicit. Recommended. Easy to inspect via browser or curl |
| Header | `Accept: application/vnd.api.v1+json` | Keeps the URL clean, but harder to debug and more costly to adopt |
| Query param | `/users?version=1` | Tends to complicate cache keys. Not recommended |

### Operating Rules

- Version only the major number (`v1`, `v2`). Don't bump the version for backward-compatible changes (added fields, new endpoints).
- Only cut a new version for breaking changes (removed fields, type changes, making a field required, changed behavior).
- Announce a deprecation date for old versions and signal it via `Deprecation` / `Sunset` headers.
- For internal-only APIs, it's reasonable to skip versioning and deploy the client and server together. For public APIs, versioning is mandatory.

## 7. Idempotency

- Implement **GET, PUT, and DELETE as idempotent**: sending the same request multiple times must leave the resource in the same state.
  - A second DELETE may return 404 (the state — "doesn't exist" — is unchanged). If you'd rather keep the client logic simple, returning 204 again on the second call is also acceptable.
- **POST is not idempotent**. You need a defense against duplicate execution from network failures or retries (double charges, duplicate orders).

### Idempotency Keys

The client sends a unique-per-request key (a UUID) in an `Idempotency-Key` header, and the server stores the key alongside the processing result for some retention window. On a retry with the same key, **return the stored response as-is**.

```typescript
// NestJS: sketch of duplicate-POST protection via an idempotency key
@Post('payments')
async create(@Headers('idempotency-key') key: string, @Body() dto: CreatePaymentDto) {
  if (!key) throw new BadRequestException('Idempotency-Key header is required');
  const cached = await this.idempotencyStore.find(key);
  if (cached) return cached.response;           // Retry: return the stored result
  const result = await this.payments.create(dto);
  await this.idempotencyStore.save(key, result, { ttl: '24h' });
  return result;
}
```

- Store the key under a unique constraint, and prevent concurrent-execution races with a transaction or lock.
- This is mandatory for any POST where duplicate execution causes real harm — payments, orders, notification sends.

## 8. Authentication and Authorization

### Token Authentication Basics

- Send tokens via the `Authorization: Bearer <token>` header. Never put a token in a query parameter (it leaks into logs and referrers).
- Keep access tokens short-lived (minutes to an hour) and refresh them with a refresh token.
- 401 means "authentication failed"; 403 means "authenticated, but not authorized." Don't conflate them.

### Per-Resource Authorization Checks

Keep authentication (who you are) separate from authorization (what you can do), and **always check ownership/permission against the specific resource being accessed**. Letting a request through on authentication alone, with direct object access by ID, is the textbook API vulnerability (IDOR / BOLA).

- Filter list endpoints at the query level. Filtering after fetching breaks pagination and result counts.
- When denying access to a single resource because the caller lacks permission, return 404 if you want to hide its existence (see section 2).
- For the authorization implementation mechanics and code examples (NestJS Guards, Laravel Policies, DRF `permission_classes`, etc.), see backend-patterns.

## 9. Rate Limiting

- Limit request counts per user (or token, or IP). Apply stricter limits to unauthenticated endpoints.
- On exceeding the limit, return **429 Too Many Requests** with a `Retry-After` header telling the client how many seconds until it can retry.
- Report the current limit state in every response's headers.

```
RateLimit-Limit: 100
RateLimit-Remaining: 42
RateLimit-Reset: 1718100000
Retry-After: 30          # only present on 429
```

(The `X-RateLimit-*` header family is also widely used. Pick one convention per project.)

- Apply a separate, stricter limit to authentication-related endpoints (login, password reset) than to the rest of the API.
- For implementation mechanics (each framework's throttling middleware, etc.), see backend-patterns.

## 10. Design Review Checklist

- [ ] Are paths plural nouns, with nesting no deeper than two levels?
- [ ] Does each endpoint's method and status codes (including 201/204/409/422) match its actual semantics?
- [ ] Do all endpoints return errors in the same shape? Are validation errors broken out per field?
- [ ] Do errors avoid leaking internal information (stack traces, SQL, file paths)?
- [ ] Does every list endpoint paginate, with the limit enforced server-side?
- [ ] Are filterable/sortable fields restricted to an allowlist?
- [ ] Is the versioning policy defined, including how breaking changes are handled?
- [ ] Do POSTs where duplicate execution causes real harm have idempotency-key protection?
- [ ] Is there object-level authorization on every resource (IDOR protection)? Is the 403/404 policy consistent?
- [ ] Is rate limiting configured, with 429 and RateLimit headers reported?

## Related

- Use the `/code-review` command for post-implementation code review.
- Delegate detailed API implementation review criteria (security, performance, convention compliance) to code-reviewer subagents.
