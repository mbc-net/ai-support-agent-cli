---
name: integration-testing
description: A collection of integration-testing patterns for verifying actual database reads and writes. Covers the limits of mocking, isolating the test database, transaction rollback, and how to verify constraint violations, optimistic locking, and N+1 queries, for NestJS (TypeORM/Prisma), Django, Flask, Laravel, and CakePHP. Use this when writing or reviewing tests for DB-touching features, when you want to avoid a "green only because it's mocked" false sense of safety, or when designing how DB tests run in CI.
---

# integration-testing: Integration Testing (DB Read/Write Verification) Patterns

## 1. Why Integration Tests Are Necessary (The Limits of Mocking)

Unit tests that mock the repository or ORM never verify any of the following:

- Correctness of SQL or query-builder output (typo'd column names, wrong JOIN conditions)
- Consistency with the schema (missing migrations, type mismatches)
- DB constraint behavior (unique constraints, foreign keys, NOT NULL, CHECK)
- Transaction boundaries (commit/rollback timing)
- Optimistic locking and concurrency conflicts

### The Classic Trap: Tests Are Green, but the DB Breaks

```typescript
// Bad: the repository is mocked, so a unique-constraint violation is never caught
it('can register a user', async () => {
  const repo = { save: jest.fn().mockResolvedValue({ id: 1 }) };
  const service = new UserService(repo as any);
  await service.register('taro@example.com');
  await service.register('taro@example.com'); // the mock silently succeeds
  expect(repo.save).toHaveBeenCalledTimes(2); // green, but in production the
});                                             // second call hits a unique-constraint 500 error
```

```typescript
// Good: register against a real DB and verify the behavior on duplicates
it('throws ConflictException when the email address is duplicated', async () => {
  await service.register('taro@example.com');
  await expect(service.register('taro@example.com'))
    .rejects.toThrow(ConflictException); // confirms constraint-violation handling against a real DB
});
```

As long as the mocked `save` keeps returning success, the test stays green forever — and a unit test will never catch "the second registration fails on the DB's unique constraint" or "the service layer never converts that exception into the right HTTP error." Those are exactly the failures that show up in production.

## 2. Dividing Responsibilities Across Test Layers

| Layer | Target | DB | Responsibility |
|---|---|---|---|
| Unit | Pure logic (calculations, transforms, validation) | Not used | Branch coverage, edge cases |
| Integration | Repository/service layer, queries | Real DB | Correctness of DB-touching code |
| E2E | Business flows through the UI/API | Real DB (production-like) | User-facing scenarios |

- Verifying DB-touching code is the responsibility of integration tests. Pushing that burden onto E2E tests makes them slow and flaky.
- For E2E test structure and waiting strategies, see the e2e-testing skill.

## 3. Core Principles for DB Testing

### 3.1 Isolate the Test Database

Never share the development database. Test runs will destroy data if you do, so use a dedicated database (e.g. `myapp_test`) or a disposable container. Switch the connection target via environment variables, and verify "this is really the test connection" at test startup to prevent accidents.

### 3.2 Keep Tests Independent of Each Other

No test may depend on data left behind by a previous test. There are two cleanup strategies:

- **Transaction rollback**: wrap each test in a transaction and roll it back at the end. Fast — but it can't verify code paths where the code under test explicitly commits, uses a separate connection, or relies on nested transactions.
- **Truncate/recreate**: truncate all tables between tests. Slower, but it also works for logic that involves an actual commit (i.e. testing the transaction boundary itself).

Rule of thumb: default to the rollback strategy, and switch to truncation only for the specific tests that verify transaction behavior or post-commit hooks.

### 3.3 Use the Same DB Engine as Production (the SQLite-Substitute Trap)

"Let's just use SQLite for speed" is a reliable source of both false positives and false negatives.

- **Loose typing**: SQLite will happily store 100 characters in a `VARCHAR(10)`. Length-overflow bugs go undetected.
- **Constraints**: foreign keys are disabled by default, and CHECK constraints and some unique-constraint behaviors differ from production engines.
- **Functions and SQL dialect**: differences in `ILIKE`, `ON CONFLICT`, window functions, and date functions mean things break only in production, or only in tests.
- **Locking behavior**: SQLite locks the whole database rather than individual rows, so concurrency and deadlock tests can't meaningfully run against it.

Use Testcontainers or Docker Compose to spin up the same PostgreSQL/MySQL you run in production. The few seconds of startup cost is easily absorbed by reusing one container per test suite.

### 3.4 Mock External APIs, but Never Mock the Database

The boundary for an integration test is: "things we own are real, things we don't own can be mocked." Payment gateways, email delivery, and external SaaS can reasonably be mocked (or stubbed). The database, however, is the very thing whose schema and constraints you're trying to verify — so it must never be mocked.

## 4. What You Must Always Test

1. **Read-back after write**: read the saved value back through a separate path (a repository `find`, or raw SQL) and confirm what was actually persisted. Checking only the return value of `save` will miss values that never made it to the DB — lost conversions, missing column mappings, and the like.
2. **Behavior on constraint violations**: deliberately trigger unique-constraint, foreign-key, and NOT NULL violations, and confirm the application layer converts them into the right exception or error response.
3. **Transaction atomicity**: force a failure partway through a multi-table update (e.g. the second of two writes violates a constraint), then read back the first write to confirm it was rolled back too.
4. **Concurrency and optimistic locking**: fetch a versioned entity in two separate contexts, update one first, then update the other, and confirm a conflict exception is raised.
5. **Complex queries**: for JOINs, aggregations, and pagination, insert real data that includes boundary conditions and verify the results (zero rows, exact page boundaries, stable sort ordering on duplicate keys).
6. **N+1 detection**: assert on the query count, confirming that listing endpoints don't issue a number of queries proportional to the row count.

## 5. Stack-Specific Implementation Patterns

### 5.1 NestJS + TypeORM (Testcontainers)

```typescript
// Good: spin up a real PostgreSQL via Testcontainers and verify against the real repository
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let container: StartedPostgreSqlContainer;
let module: TestingModule;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  module = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'postgres',
        url: container.getConnectionUri(),
        entities: [User, Order],
        migrations: ['migrations/*.ts'],
        migrationsRun: true, // apply real migrations instead of `synchronize`
      }),
      UserModule, // use the real repository, not a mock
    ],
  }).compile();
}, 60_000);

afterEach(async () => {
  // truncate strategy: needed because this suite tests transaction boundaries
  await module.get(DataSource).query('TRUNCATE "user", "order" CASCADE');
});

it('rolls back the stock decrement when order confirmation fails partway through', async () => {
  const service = module.get(OrderService);
  await expect(service.confirm(orderWithInvalidItem)).rejects.toThrow();
  const stock = await module.get(DataSource).getRepository(Stock).findOneBy({ sku: 'A' });
  expect(stock.quantity).toBe(10); // the first decrement was rolled back too
});
```

### 5.2 NestJS + Prisma

```typescript
// Good: point DATABASE_URL at the container and run `prisma migrate deploy`
beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  execSync('npx prisma migrate deploy'); // build the schema from real migrations
  prisma = new PrismaClient();
});

it('reads back a saved value', async () => {
  await service.createUser({ email: 'taro@example.com', name: 'Taro' });
  // read back directly from the DB instead of trusting the return value of save
  const row = await prisma.user.findUnique({ where: { email: 'taro@example.com' } });
  expect(row?.name).toBe('Taro');
});

it('catches a unique-constraint violation as P2002 and handles it', async () => {
  await service.createUser({ email: 'a@example.com', name: 'A' });
  await expect(service.createUser({ email: 'a@example.com', name: 'B' }))
    .rejects.toThrow(ConflictException);
});
```

### 5.3 Django + pytest-django

```python
# Good: the django_db mark uses a real DB; by default each test is rolled back afterward
import pytest

@pytest.mark.django_db
def test_read_back_after_save():
    Order.objects.create(code="A-001", total=1000)
    row = Order.objects.get(code="A-001")
    assert row.total == 1000

# Use transaction=True (equivalent to TransactionTestCase) when testing the
# transaction boundary itself — select_for_update and on_commit hooks only work here
@pytest.mark.django_db(transaction=True)
def test_full_rollback_on_partial_failure():
    with pytest.raises(IntegrityError):
        place_order_with_invalid_item()
    assert Stock.objects.get(sku="A").quantity == 10

# N+1 detection: assert on the query count
def test_listing_uses_2_queries_regardless_of_row_count(django_assert_num_queries):
    OrderFactory.create_batch(20)
    with django_assert_num_queries(2):  # pins down the effect of select_related / prefetch_related
        list_orders_with_items()
```

Rule of thumb: default to `@pytest.mark.django_db` (the fast rollback strategy). `transaction=True` actually commits, so it's slower — reserve it for the specific tests that need it.

### 5.4 Flask + pytest (SQLAlchemy)

```python
# Good: share one PostgreSQL container for the whole session, and roll back after each test
@pytest.fixture(scope="session")
def engine():
    with PostgresContainer("postgres:16") as pg:
        engine = create_engine(pg.get_connection_url())
        run_migrations(engine)  # apply the real schema via Alembic
        yield engine

@pytest.fixture
def db_session(engine):
    conn = engine.connect()
    trans = conn.begin()
    session = Session(bind=conn, join_transaction_mode="create_savepoint")
    yield session          # even if the code under test commits, it stays inside the savepoint
    session.close()
    trans.rollback()       # the independence between tests is guaranteed by the outer transaction
    conn.close()

def test_foreign_key_violation_becomes_400(client, db_session):
    res = client.post("/orders", json={"user_id": 9999})  # a user that doesn't exist
    assert res.status_code == 400  # confirms IntegrityError is converted, not swallowed
```

### 5.5 Laravel + PHPUnit

```php
// Good: RefreshDatabase wraps each test in a transaction and rolls it back quickly
use Illuminate\Foundation\Testing\RefreshDatabase;

class OrderTest extends TestCase
{
    use RefreshDatabase;

    public function test_saved_value_is_persisted_to_the_database(): void
    {
        $user = User::factory()->create();
        $this->postJson('/api/orders', ['user_id' => $user->id, 'total' => 1000])
             ->assertCreated();
        // Good: use assertDatabaseHas to verify the actual data in the DB
        $this->assertDatabaseHas('orders', ['user_id' => $user->id, 'total' => 1000]);
    }

    public function test_duplicate_registration_returns_409(): void
    {
        User::factory()->create(['email' => 'taro@example.com']);
        $this->postJson('/api/users', ['email' => 'taro@example.com'])
             ->assertStatus(409);
        $this->assertDatabaseCount('users', 1); // also confirm no extra row was created
    }
}
```

Note: pin the connection in `phpunit.xml` to the test database. Don't swap in SQLite's `:memory:` — that reintroduces the trap described in 3.3. If production runs MySQL, test against a MySQL container.

### 5.6 CakePHP + PHPUnit

```php
// Good: manage tables and data via fixtures against the `test` connection
class OrdersTableTest extends TestCase
{
    protected array $fixtures = ['app.Orders', 'app.Users']; // loaded into the test connection

    public function test_total_aggregation_query_is_correct(): void
    {
        $orders = $this->getTableLocator()->get('Orders');
        $total = $orders->find()->where(['user_id' => 1])->sumOf('total');
        $this->assertSame(3000, $total); // expected value is derived from the fixture data
    }
}
```

Define a dedicated database under `Datasources.test` in `config/app_local.php`. It's worth verifying in your test bootstrap that this isn't accidentally pointing at the same database as the default connection.

## 6. Running in CI

- **Starting the DB container**: on GitHub Actions, either define it under `services:` (PostgreSQL/MySQL) or run Testcontainers directly (requires a runner with Docker available). Wait for a health check (e.g. `pg_isready`) before starting the tests.
- **Applying migrations**: always run real migrations before the test suite. Relying on `synchronize` or schema auto-generation means you can't detect missing migrations.
- **DB isolation under parallel execution**: assign each worker its own database. For Jest, suffix the DB name with `JEST_WORKER_ID`; for pytest-xdist, split by worker ID such as `gw0` (pytest-django appends a suffix automatically). If you can't isolate databases, fall back to serial execution (e.g. `--runInBand`).
- **Debugging CI-only failures**: if a test only fails in CI, suspect insufficient container-startup waiting, database sharing under parallel execution, or timezone/locale differences.

## 7. Related

- Overall test-layer picture and how to write E2E tests: the e2e-testing skill
- Measuring coverage and finding gaps: `/test-coverage`
- Reviewing test code: the code-reviewer subagent
