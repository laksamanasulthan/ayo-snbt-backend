# Testing Guide

The Ayo-SNBT backend has a two-tier test campaign: fast unit tests and
stack-backed integration tests. Together they cover **normal + edge cases** for
every slice: auth, RBAC, courses, questions, simulations, video, chat,
payments, and the cross-cutting resilience layer.

## Running

```bash
# Unit tests (no infrastructure needed)
npm test

# Integration tests — REQUIRE the compose stack:
docker compose -f compose.dev.yml up -d postgres pgbouncer redis mongo minio minio-init mailpit
npm run test:integration

# Everything (unit + integration), full gate:
npm run lint && npm run typecheck && npm test && npm run test:integration
```

## Test layout

| Area        | File                                                                                                        | Covers                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Unit        | `tests/unit/pagination.test.ts`                                                                             | cursor encode/decode, tamper rejection, limit parsing/capping, keyset SQL, page building                                             |
| Unit        | `tests/unit/event-bus.test.ts`                                                                              | typed emit/on/off, multi-subscriber, throwing-handler isolation, fire-and-forget                                                     |
| Unit        | `tests/unit/{jwt,password,lockout,guards,envelope,backoff,circuit-breaker,degradation,cache-aside}.test.ts` | existing pure-logic suites                                                                                                           |
| Auth        | `tests/integration/auth-edge.test.ts`                                                                       | validation, duplicate email, token reuse/expiry/rotation, concurrent refresh race, lockout windows, password reset lifecycle, CSRF   |
| RBAC        | `tests/integration/rbac-edge.test.ts`                                                                       | role→permission matrix, ownership, IAM assignment, token tampering                                                                   |
| Courses     | `tests/integration/courses-edge.test.ts`                                                                    | cursor walk (no dupes/gaps), drafts, soft-delete/restore, enroll gates, progress bounds                                              |
| Questions   | `tests/integration/questions-edge.test.ts`                                                                  | atomic option replace, ownership, soft-delete hidden from bank, double-delete                                                        |
| Simulations | `tests/integration/simulations-edge.test.ts`                                                                | empty package/bank, expiry auto-submit, SESSION_CLOSED, double-submit, percentile/rank ties, leaderboard                             |
| Video       | `tests/integration/video-edge.test.ts`                                                                      | content-type guard, idempotent confirm, streaming gates, path traversal, segments                                                    |
| Chat        | `tests/integration/chat-edge.test.ts`                                                                       | room dedupe/determinism, WS protocol errors, send rate limit, seq cursors                                                            |
| Payments    | `tests/integration/payments-edge.test.ts`                                                                   | lazy expiry, webhook idempotency (eventId), signature, refund state machine, fulfill guards                                          |
| Resilience  | `tests/integration/resilience-edge.test.ts`                                                                 | envelopes + requestId, 22P02→400, rate-limit isolation (non-minimal app), tx rollback, idempotency keys, parallel-enroll convergence |

## Bugs the campaign caught (and fixed)

1. **Refresh rotation race** — two concurrent refreshes with the same token
   both succeeded. Fixed with an atomic `revokedAt IS NULL` conditional update
   in `src/modules/auth/service.ts`; exactly one now wins, the loser gets
   `TOKEN_REUSE_DETECTED` + family revocation.
2. **Ambiguous keyset columns** — cursor page 2+ of `GET /courses` and
   `GET /simulations/sessions` joined tables with `created_at`/`id` → SQL
   error 500. Columns are now fully qualified (`courses.created_at` etc.).
3. **Non-UUID ids → 500** — PG `22P02` (incl. wrapped in DrizzleQueryError)
   is now mapped to `400 INVALID_ID` in the global error handler.
4. **Parallel enroll race** — two concurrent free-course enrolls → unique
   violation 500. `coursesService.enroll` now uses `onConflictDoNothing()`.
5. **IAM unknown-user assignment → 500** — FK violation surfaced as 500;
   now a clean `404 User not found`.
6. **Register schema gaps** — `email` format + `password` minLength were
   missing; invalid emails / weak passwords were accepted (201).
7. **Inconsistent limit validation** — `GET /courses?limit=0` was accepted
   (empty page) while other modules rejected it; the route now uses
   `parseLimit` (400 INVALID_LIMIT, cap 100).

## Infrastructure notes

- Integration tests share the compose DB (sequential files, no parallelism).
- Redis persists between runs — suites clear rate-limit/lockout/WS buckets in
  `beforeAll` via `ensureRedisConnected()` (the app Redis client uses
  `enableOfflineQueue: false`, so cleanup must wait for the `ready` event).
- The rate-limit plugin only registers when `minimal: false` — the
  resilience suite builds a second app instance for the 429 tests.
