---
name: database-migrations
description: A pattern library for running database migrations safely. Covers universal principles such as backward compatibility, the expand/contract pattern, and rollback design; dangerous operations to avoid in PostgreSQL/MySQL; tool-specific notes for Django, Laravel, TypeORM, and Prisma; and lazy migration for DynamoDB. Use this when planning or reviewing schema changes, data migrations, or migration files.
---

# Database Migrations — Patterns for Safe DB Migrations

Migrations against a production database tend to be operations you can't undo once they fail.
This skill collects the principles, dangerous patterns, and tool-specific pointers needed to
carry out schema changes and data migrations with zero downtime and zero data loss.

## 1. Universal Principles

### 1.1 Backward compatibility: don't break the old code while it's still running

During a deploy there is always a moment where "old code + new schema" or "new code + old schema"
coexist. With rolling deploys this window can last minutes; even with blue/green deploys there's
a brief moment of overlap at cutover. A migration must therefore always satisfy both of these:

- The new schema must not break the old code (don't drop or rename columns first)
- The new code must be able to start up against the old schema (don't assume a new column is
  already required)

### 1.2 Expand / Contract (the two-phase deploy)

Never make a breaking change in one shot. Always break it down into "add → migrate → remove."

```text
Phase 1 (Expand)   : Add new columns/tables. Old code simply ignores them, so nothing breaks
Phase 2 (Migrate)  : Deploy new code that writes to both, or treats the new side as authoritative.
                      Backfill the data
Phase 3 (Contract) : Once you've confirmed all code reads only from the new side, drop the old
                      columns/tables
```

Leave at least one full deploy cycle between Phase 1 and Phase 3.
There's no need to rush Phase 3 — you can always delete later, but deleted data doesn't come back.

### 1.3 Rollback-ability

- For every migration, ask: "if the app is rolled back to the previous version right after this
  migration is applied, does it still work?"
- A rollback mechanism doesn't have to be a "down" migration. If you follow expand/contract,
  rolling back just the application *is* the rollback (the schema can safely stay in its
  forward-compatible state)
- Destructive operations (DROP, TRUNCATE, narrowing a column's type) can't be undone by a down
  migration. Take a backup or archive the data to a separate table before running them

### 1.4 Keep schema changes and data migrations separate

Don't mix DDL (schema changes) and DML (data migrations) in the same migration.

- DDL finishes quickly and its lock impact is easy to estimate. DML scales with row count and can
  run long
- Mixing them means that if something fails partway through, you're left in the worst possible
  state: the schema changed but the data is half-migrated
- Put data migrations in their own migration, or better, a separate batch job or management
  command

### 1.5 One migration, one purpose

Each file should contain exactly one logical change.
Cramming "add a column to `users` + add an index to `orders` + drop an unused table" into one file
makes it hard to reason about state after a partial failure and hard to retry just the failed
piece. Keeping migrations small makes it easy to pinpoint what failed, retry it, and review it.

## 2. Dangerous Patterns in PostgreSQL / MySQL

### 2.1 Adding a NOT NULL column to a large table

```sql
-- Dangerous: on PostgreSQL 10 and earlier, or some MySQL configurations, this rewrites
-- every row and holds a long-lived lock
ALTER TABLE orders ADD COLUMN status varchar(20) NOT NULL DEFAULT 'pending';

-- Safe, staged migration (PostgreSQL)
ALTER TABLE orders ADD COLUMN status varchar(20);             -- 1. Add nullable (instant)
-- 2. Deploy the app so it writes a value on new rows
-- 3. Backfill existing rows in batches (see 2.4)
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'pending'; -- 4. Set the default
ALTER TABLE orders ALTER COLUMN status SET NOT NULL;          -- 5. Enforce NOT NULL last
```

On PostgreSQL 11+, `ADD COLUMN` with a constant default is a metadata-only change and is fast,
but `SET NOT NULL` still requires a full table scan. On PostgreSQL 12+, it's safer to first add
`CHECK (status IS NOT NULL) NOT VALID` and then run `VALIDATE CONSTRAINT`.

### 2.2 Locking caused by index creation

```sql
-- Dangerous: a plain CREATE INDEX blocks writes to the table
CREATE INDEX idx_orders_user_id ON orders (user_id);

-- Safe: use CONCURRENTLY on PostgreSQL (must run outside a transaction)
CREATE INDEX CONCURRENTLY idx_orders_user_id ON orders (user_id);
```

- `CONCURRENTLY` cannot run inside a transaction. In Django this means `atomic = False`; other
  tools have their own way to disable the per-migration transaction
- If it fails, an INVALID index is left behind. Drop it with `DROP INDEX CONCURRENTLY` and retry
- MySQL (InnoDB) usually supports online DDL, but be explicit with
  `ALTER TABLE ... ALGORITHM=INPLACE, LOCK=NONE` so you get an error (rather than a silent lock)
  if it's not possible
- For very large tables on MySQL, consider gh-ost or pt-online-schema-change

### 2.3 Renaming a column or changing its type: do it as a staged migration

`RENAME COLUMN` itself is fast, but as soon as it runs, any old code still referencing the old
name breaks immediately. Treat a rename as "add a column under a new name."

```text
1. Add the new-named column (nullable)
2. Deploy the app so it writes to both columns, but still reads from the old one
3. Backfill the data by copying old -> new
4. Deploy the app so it reads from the new column (still writing to both)
5. Deploy the app so it writes only to the new column
6. Drop the old column (Contract)
```

Type changes (e.g. int -> bigint) follow the same recipe by going through a new column of the
new type. On PostgreSQL, `ALTER TYPE` often rewrites every row under an ACCESS EXCLUSIVE lock.
The exception is compatible changes, like widening a varchar, which are metadata-only.

### 2.4 Batching backfills

A single bulk UPDATE against existing rows causes long-running transactions, replication lag,
lock contention, and (on PostgreSQL) VACUUM pressure. Always split it up.

```sql
-- Dangerous: a single bulk update (tens of millions of rows will blow up locks and WAL/binlog)
UPDATE orders SET status = 'pending' WHERE status IS NULL;

-- Safe: batch by primary key range
UPDATE orders SET status = 'pending'
WHERE id IN (
    SELECT id FROM orders
    WHERE status IS NULL
    ORDER BY id
    LIMIT 5000          -- tune the batch size based on observed load
);
-- Loop this from the application until zero rows match
```

- Commit each batch in its own transaction, and add a short pause between batches
- Write it idempotently (the WHERE clause should make it safe to re-run after a partial failure)
- Check a replica-lag metric inside the loop and pause if it exceeds a threshold

## 3. Tool-Specific Notes

### 3.1 Django migrations

```bash
# Always add this to CI: it catches model/migration drift (a missing makemigrations)
python manage.py makemigrations --check --dry-run

# Get in the habit of reviewing the SQL that will actually run before applying it
python manage.py sqlmigrate shop 0042
```

```python
from django.db import migrations

def forwards(apps, schema_editor):
    # Always use apps.get_model. Importing the model directly will break this
    # migration when the model changes in the future
    Order = apps.get_model("shop", "Order")
    while True:
        ids = list(
            Order.objects.filter(status__isnull=True).values_list("id", flat=True)[:5000]
        )
        if not ids:
            break
        Order.objects.filter(id__in=ids).update(status="pending")

class Migration(migrations.Migration):
    atomic = False  # Disable the per-migration transaction for bulk data work or
                     # CREATE INDEX CONCURRENTLY
    dependencies = [("shop", "0041_add_status")]
    operations = [
        # Always specify reverse. Even if no reverse action is needed, make the noop
        # explicit rather than leaving the migration irreversible
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
```

- Leaving `reverse` unspecified on `RunPython` makes that migration irreversible
- For adding indexes on PostgreSQL, use `AddIndexConcurrently`
  (`django.contrib.postgres.operations`) together with `atomic = False`
- Squash migrations periodically to keep fresh-environment setup time and the dependency graph
  manageable

### 3.2 Laravel migrations

```php
public function up(): void
{
    Schema::table('orders', function (Blueprint $table) {
        // Add as nullable; enforce NOT NULL in a separate migration
        $table->string('status', 20)->nullable();
    });
}

public function down(): void
{
    Schema::table('orders', function (Blueprint $table) {
        $table->dropColumn('status');
    });
}
```

- Always write `down()` for local-dev convenience, but don't rely on it as your production
  rollback mechanism. In production, handle rollback via expand/contract plus rolling back the
  application, not `migrate:rollback`
- MySQL implicitly commits DDL statements, so packing multiple DDL statements into one file can
  leave things half-applied after a mid-migration failure. Stick to one migration, one purpose
- `php artisan migrate --pretend` lets you preview the SQL before it runs

### 3.3 TypeORM / Prisma

- TypeORM: never use `synchronize: true` in production (it rewrites the schema implicitly).
  Always eyeball the SQL that `migration:generate` produces to make sure it doesn't contain an
  unintended DROP. Running migrations explicitly from the deploy pipeline via `migration:run` is
  easier to control than auto-running them at app startup (`migrationsRun`)
- Prisma: use only `prisma migrate deploy` for production. `migrate dev` is for local development
  only and can create/reset a shadow database. Don't use `prisma db push` in production either,
  since it doesn't leave a migration history. The generated `migration.sql` file can be hand
  edited, so make adjustments like switching `CREATE INDEX` to `CONCURRENTLY` directly in that
  file
- For both tools, "auto-generated" does not mean "safe." A rename being generated as DROP + ADD,
  losing data in the process, is a classic mistake with either tool

## 4. DynamoDB

Being schemaless doesn't mean migrations go away — it just means the schema has moved into the
application code, and the application is now responsible for compatibility.

### 4.1 Lazy migration (migrate on read)

Rewriting every item in bulk is expensive and risky, so convert items to the new shape lazily,
as they're read.

```typescript
// Give each item a version attribute and convert it incrementally on read
function migrateItem(item: Record<string, any>): Order {
  const version = item.schemaVersion ?? 1;
  if (version < 2) {
    // v1 -> v2: split fullName into firstName / lastName
    const [firstName, ...rest] = (item.fullName ?? '').split(' ');
    item.firstName = firstName;
    item.lastName = rest.join(' ');
    item.schemaVersion = 2;
  }
  return item as Order;
}
```

- Always write items back in the latest shape, along with an updated `schemaVersion`
- Your read-path conversion function needs to keep supporting conversion from every past version.
  If you want to drop support for old versions, run a one-time background scan-and-migrate job
  first to bring everything current
- If you do run a bulk migration, use a segmented parallel Scan with rate limiting so you don't
  eat into your write capacity

### 4.2 Operating GSI additions

- Adding a GSI can be done online, but the backfill takes time, and queries against the index
  before it finishes will return incomplete results. Wait until the index reports ACTIVE before
  cutting the application over to it
- In other words, a GSI addition needs the same two-phase deploy as an RDBMS expand/contract:
  add -> wait for backfill -> cut over the code
- A GSI's key attributes can't be changed after creation. To change them, add a new GSI and drop
  the old one once you've cut over

### 4.3 Key design changes are hard

- Partition keys and sort keys can't be changed once a table is created. Changing them really
  means "create a new table, copy all the data, and cut over"
- In a CQRS setup, if you design things so the read model (query-side table) can be rebuilt from
  the command-side events, then a key-design change on the query side reduces to a re-projection
- Where a migration truly is needed, set up dual writes via DynamoDB Streams, and cut reads over
  to the new table once the copy is complete

## 5. Pre-Execution Safety Checklist

1. Will the previous version of the application still work after this schema change (backward
   compatibility)?
2. If this includes a breaking change (DROP / RENAME / narrowing a type), has it been broken down
   into expand/contract?
3. Have you checked the row count and size of the target table, and estimated the runtime against
   a production-scale data volume?
4. Have you identified what kind of lock will be taken, and how lock waits will affect the
   application?
5. Have you set `lock_timeout` / `statement_timeout` (or `lock_wait_timeout` on MySQL)?
6. Is the data migration batched and idempotent, with a documented recovery procedure for a
   partial failure?
7. Have you documented the rollback procedure (one that doesn't depend on a down migration)?
8. Have you verified that a backup / snapshot / PITR is in place right before running it?
9. Have you rehearsed this against production-scale data in staging?
10. Have you picked a low-traffic execution window and lined up monitoring (replica lag, locks,
    error rate)?

## 6. Anti-patterns

| Anti-pattern | What happens | Do this instead |
| --- | --- | --- |
| Releasing a column drop and the code change together | Old code crashes mid-rollout | Do the Contract step in a separate release, after the rollout is fully complete |
| Running `RENAME COLUMN` in one shot | Old code errors out immediately | Add a new column, dual-write, then cut over in stages |
| Bulk UPDATE against a huge table | Long transactions, locking, replica lag | Batch by primary-key range, with pauses |
| `CREATE INDEX CONCURRENTLY` inside a transaction | Errors out, or silently runs as a regular, locking `CREATE INDEX` | Disable the transaction and run it standalone |
| Mixing DDL and DML in one migration | A failure leaves things half-applied | Separate schema changes from data migrations |
| Treating a down migration as your production rollback plan | Data loss, or an unverified down that itself fails | Preserve forward compatibility and roll back via the application instead |
| Applying ORM-generated SQL without review | A rename becomes DROP + ADD and data is lost | Always eyeball the generated SQL |
| Using `synchronize: true` / `db push` in production | Implicit schema changes with no migration history | Change the schema only via migration files |
| Rewriting all DynamoDB items in one pass | Production impact from exhausted capacity | Use lazy migration, or a rate-limited bulk migration |
| Importing application models directly inside a migration | A future model change breaks past migrations | Use a historical model (e.g. Django's `apps.get_model`) |

## 7. Related Workflow

- Before starting a large schema change, use `/plan` to work out the breakdown into
  expand/contract steps and the release ordering
- Send changes that include migrations to `/code-review`
- For Django-specific migration safety (transaction control, `RunPython` reverse functions,
  lock-holding operations), have the `django-reviewer` subagent take a close look
