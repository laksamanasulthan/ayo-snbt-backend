# Architecture

Ayo-SNBT is a **vertical-slice, horizontally scalable** Fastify backend.
This document explains how the pieces fit together. Complementary reads:
[API-CONVENTIONS.md](./API-CONVENTIONS.md) (wire contract),
[DATABASE.md](./DATABASE.md) (data layer), [QUEUEING.md](./QUEUEING.md) (async),
[SCALING.md](./SCALING.md) (capacity).

## Process topology

```
                         ┌───────────────────────────┐
   clients ──► HAProxy ──►  api replicas (n ×)      │
   (REST + WS)   :80     │  Fastify 5 + TS          │
                         └──────┬───────┬───────────┘
                                │       │
                     ┌──────────▼─┐   ┌─▼──────────────┐
                     │ PgBouncer  │   │ Redis 7        │
                     │ (tx pool)  │   │ cache/rate-limit│
                     └──────┬─────┘   │ queues/presence│
                            │         └─┬──────────────┘
                     ┌──────▼─────┐   ┌─▼──────────────┐
                     │ PostgreSQL │   │ worker (BullMQ)│
                     │ 18 (+repl) │   │ ffmpeg variant │
                     └────────────┘   └────────────────┘
        MongoDB (chat)      MinIO/S3 (media)     SMTP (Mailpit dev)
```

- The **API** is stateless — any number of replicas behind HAProxy.
- The **worker** consumes BullMQ queues (email, transcode, grading, payment).
- The **ffmpeg worker image** (`docker/Dockerfile.worker-ffmpeg`) is the only
  place ffmpeg/ffprobe exist.

## Vertical slices

Each feature lives in `src/modules/<slice>/`:

```
routes.ts      HTTP surface: schemas, guards, envelope replies — no business logic
service.ts     business rules, transactions, audit, events
repository.ts  ALL database access (applies notDeleted filters)
index.ts       re-exports
```

| Slice         | Responsibility                                                                 |
| ------------- | ------------------------------------------------------------------------------ |
| `auth`        | register/verify/login/refresh/logout, password reset, OAuth2, mail templates   |
| `users`       | profile read/update, avatar presign                                            |
| `iam`         | roles/permissions listing, role assignment (admin)                             |
| `courses`     | catalog (cursor-paginated, cached), lessons, progress, enrollment, soft-delete |
| `questions`   | question bank + options (transactional replace)                                |
| `video`       | upload intent, presign, transcode trigger, streaming gates                     |
| `simulations` | packages, timed sessions, answers, grading, leaderboard                        |
| `chat`        | rooms, messages (Mongo), WS gateway, presence                                  |
| `payments`    | orders, provider adapters, webhooks, fulfillment, refunds                      |
| `system`      | /health, /ready                                                                |

Shared kernel in `src/shared/`: http (envelope/errors/rate-limit/idempotency),
db (client/transaction/filters), redis (client/circuit-breaker/degradation),
cache (cache-aside + version tags), queue, events, audit, context, backoff,
auth (jwt/password/cookies/lockout), rbac, s3, mongo, mail, metrics, logger.

## Request lifecycle

```
request
  │  onRequest:  requestId (X-Request-Id + envelope echo; honors incoming)
  │  preHandler: request context (AsyncLocalStorage: actorId, ip, userAgent)
  │              authGuard/optionalAuth (JWT cookie → request.user)
  │              csrfGuard (double-submit cookie, mutating methods only)
  │              rate limit (per-route Redis buckets, memory fallback)
  │              idempotency (replay store for Idempotency-Key)
  ▼
handler ──► service ──► repository ──► PostgreSQL/Redis/Mongo/S3
  │              │  audit()  │ eventBus.emit() (cache invalidation)
  │              ▼
  onSend: idempotency response caching (never caches 5xx)
  ▼
reply.ok / reply.created / reply.accepted  →  JSON envelope
```

Errors: any thrown `AppError` (or PG `22P02`/validation/rate-limit) becomes a
standard error envelope via the global error handler — see
[API-CONVENTIONS.md](./API-CONVENTIONS.md).

## Request context (AsyncLocalStorage)

`shared/context/request-context.ts` exposes `getRequestContext()` →
`{ requestId, ip, userAgent, actorId }`. Hooks populate it automatically;
`audit()` reads actor/IP/requestId from it, so services never pass identity
around by hand. `setContextActor()` lets background jobs (worker) set the
actor explicitly.

## Data access rules

- **Repositories own the SQL.** Services call `repo.findById(id)` etc.;
  repositories apply `notDeleted(column)` → `isNull(deletedAt)` on every
  read (soft-delete semantics, [DATABASE.md](./DATABASE.md)).
- **Transactions.** Multi-statement writes use `withTx(fn)`. Inside the
  transaction, read back via the SAME `tx` connection — a different
  connection cannot see uncommitted rows.
- **Read replicas.** `getReadDb()` targets `DATABASE_URL_REPLICA` when set
  (used by catalog + leaderboard reads).
- **PgBouncer.** Pool uses `statement_cache_size: 0` so transaction pooling
  doesn't break prepared statements.

## Cache + invalidation

`shared/cache/cache.ts` is a cache-aside with single-flight population and
lazy bypass (unbound/Redis-down → direct DB). Every entity has a **version
tag** (`shared/cache/version.ts`): keys embed `v<cacheVersion(entity)>`;
mutations call `bumpCacheVersion(entity)`. Domain events
(`shared/events/subscriptions.ts`) map events → bumps automatically, so
invalidation follows the event bus, not hand-rolled cache deletes.

## Event bus

Typed in-process bus (`shared/events/bus.ts`, `DomainEventMap`). Handlers
run async fire-and-forget; a failing handler is logged and never breaks the
emitter. Events: course.published/deleted/restored, question.updated/deleted,
simulation_package.updated/deleted, order.fulfilled, user.password_reset,
leaderboard.changed.

## Degradation (graceful Redis failure)

`shared/redis/degradation.ts` — per-subsystem gates with circuit breakers:

| Gate      | Healthy                  | Redis down                                   |
| --------- | ------------------------ | -------------------------------------------- |
| cache     | Redis cache-aside        | DB bypass (lazy)                             |
| rateLimit | Redis buckets            | in-memory buckets (never disabled)           |
| queue     | BullMQ enqueue           | enqueue returns null → caller outbox/rejects |
| presence  | Redis pub/sub + presence | local-only WS delivery                       |

Health monitors sample ping + memory; `/ready` exposes the snapshot.
Redis client uses `enableOfflineQueue: false` — commands fail fast so the
circuit breaker (not an infinite offline queue) owns the fallback.

## Backoff strategy

`shared/backoff/retry.ts`: exponential + full jitter (AWS style). Used by
outbound calls (SMTP, S3, payment providers) and Redis reconnect strategy.
BullMQ jobs use built-in exponential backoff (2 s base, 5 attempts).

## Rate limiting (layered)

1. **HAProxy** frontend stick-table (global first line, prod).
2. **App per-route** buckets (Redis INCR+PEXPIRE fixed window, memory
   fallback) with `Retry-After` headers — e.g. login 5/min, forgot 5/min,
   refresh 20/min, progress 60/min, master playlist 120/min, segments 300/min.
3. **WS send limit** 30 msgs/min/user (chat gateway).

## Glossary (SNBT domain)

- **SNBT** — Seleksi Nasional Berdasarkan Tes (national exam by test)
- **TPS** — Tes Potensi Skolastik; categories: **PU** (Penalaran Umum),
  **PK** (Pengetahuan Kuantitatif)
- **Try out** — practice simulation; timed session with random question pick,
  scoring weights (correct/blank/wrong), percentile + rank.

## Where to go next

- Wire contract & error codes: [API-CONVENTIONS.md](./API-CONVENTIONS.md)
- Data model: [DATABASE.md](./DATABASE.md)
- Async work: [QUEUEING.md](./QUEUEING.md)
- Security model: [SECURITY.md](./SECURITY.md)
