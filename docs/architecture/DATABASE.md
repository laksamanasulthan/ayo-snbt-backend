# Database

PostgreSQL 18 behind PgBouncer (transaction pooling), accessed through
Drizzle ORM. Chat state lives in MongoDB (see
[CHAT-WEBSOCKET.md](../services/CHAT-WEBSOCKET.md)); media in S3.

## Connections

| URL env var            | Path              | Used by                                |
| ---------------------- | ----------------- | -------------------------------------- |
| `DATABASE_URL`         | → PgBouncer :6432 | application pool (transaction pooling) |
| `DIRECT_DATABASE_URL`  | → Postgres :5433  | migrations, seeding                    |
| `DATABASE_URL_REPLICA` | optional replica  | `getReadDb()` (catalog, leaderboard)   |

PgBouncer requirement: `statement_cache_size = 0` (see
`docker/pgbouncer.ini`) — otherwise prepared statements break under
transaction pooling. The pool is configured with that in mind.

## Tables

| Table                                        | Purpose                        | Notes                                                   |
| -------------------------------------------- | ------------------------------ | ------------------------------------------------------- |
| `users`                                      | accounts                       | soft-delete `deleted_at`, email verified flag           |
| `refresh_tokens`                             | opaque rotating refresh tokens | family id, revoked_at, expires_at                       |
| `email_verifications`                        | verify-email tokens            | one-time, 24 h expiry                                   |
| `password_resets`                            | reset tokens                   | one-time, 15 min expiry                                 |
| `user_identities`                            | OAuth2 provider links          | unique (provider, provider_user_id)                     |
| `roles` / `permissions` / `role_permissions` | RBAC                           | seeded (3 roles, 16 permissions)                        |
| `user_roles`                                 | user→role                      |                                                         |
| `courses`                                    | catalog                        | soft-delete, `slug` unique, mentor_id                   |
| `lessons`                                    | course content                 | soft-delete, video_id FK, is_free, sort_order           |
| `course_enrollments`                         | enrollment                     | UNIQUE (user_id, course_id)                             |
| `lesson_progress`                            | per-user progress              | UNIQUE (user_id, lesson_id)                             |
| `videos`                                     | media records                  | status lifecycle uploaded→processing→ready, soft-delete |
| `questions`                                  | question bank                  | soft-delete, created_by, category                       |
| `question_options`                           | options per question           | is_correct, sort_order; cascade-deleted with question   |
| `simulation_packages`                        | try-out configs                | question_counts JSON, scoring JSON, soft-delete         |
| `simulation_sessions`                        | student sessions               | status in_progress→submitted→graded, deadline_at        |
| `simulation_answers`                         | answers per session            | pre-created rows = session question set                 |
| `orders`                                     | payment orders                 | status state machine, order_number unique               |
| `payment_events`                             | webhook dedupe                 | UNIQUE event_id per order                               |
| `audit_logs`                                 | audit trail                    | action, resource, before/after JSON, actor, ip          |

## Migrations workflow

```bash
npm run db:generate    # diff schema → new SQL in drizzle/
npm run db:migrate     # apply (direct connection)
```

- The repo currently has ONE clean baseline migration
  (`drizzle/0000_cuddly_venom.sql`) — earlier history was squashed during the
  soft-delete refactor. New changes append migrations normally.
- Production deployments run the standalone runner first:
  `node dist/shared/db/migrate-runner.js` (Jenkins deploy step) — never
  start the new API version before migrations are applied.
- Never edit applied migrations; generate new ones.

## Transactions

- Use `withTx(fn)` (`shared/db/transaction.ts`) for multi-statement writes
  (e.g. question + options replace).
- **Read back inside the transaction via the `tx` connection.** Other
  connections cannot see uncommitted rows (this bit us — see
  [docs/adr/0003-transactions-soft-deletes.md](../adr/0003-transactions-soft-deletes.md)).
- Parallel writes that must converge use `onConflictDoNothing()`
  (enrollments: parallel enrolls → exactly one row).

## Soft deletes

| Table               | deleted_at | Restore by       | Notes                                                    |
| ------------------- | ---------- | ---------------- | -------------------------------------------------------- |
| users               | yes        | admin            | keeps email unique index active (partial unique)         |
| courses             | yes        | admin            | lessons/enrollments keep pointing at the row             |
| lessons             | yes        | (via course ops) | hidden from detail + progress joins                      |
| videos              | yes        | —                | streaming gate 404s deleted videos                       |
| questions           | yes        | owner/admin      | `question_options` follow the parent (no own deleted_at) |
| simulation_packages | yes        | admin            |                                                          |

Rules:

- Repositories apply `notDeleted()` (`isNull(deleted_at)`) on EVERY read.
- Partial unique indexes keep uniqueness among active rows.
- Soft-deleted questions are excluded from simulation question picking.
- Restore = `deleted_at = NULL` + audit + cache version bump + event.

## Audit trail

`audit({ action, resourceType, resourceId, before?, after? })` writes to
`audit_logs` and reads actor/IP/requestId from the request context
([ARCHITECTURE.md](./ARCHITECTURE.md)). Mutations in courses, questions,
simulations, and payments are audited. Worker jobs set the actor explicitly
(`setContextActor`).

## Seeding

`npm run db:seed` (`src/shared/db/seed.ts`) upserts the RBAC roles
(student/mentor/admin) and permissions. Idempotent — safe to re-run.

## Chat storage (MongoDB)

- DB: `ayosnbt_chat` (from `MONGO_URL`); collections `rooms`,
  `messages`, plus a counters collection for per-room sequence numbers.
- Indexes are ensured at boot (`ensureChatIndexes`); when Mongo is
  unreachable the chat module degrades gracefully instead of crashing boot.
