# API Conventions

Every endpoint follows the same wire contract. Interactive reference: run the
API and open <http://localhost:3000/docs> (Scalar). This document covers the
cross-cutting conventions and the full error-code catalog.

## JSON envelope

Success:

```json
{
  "success": true,
  "data": { "id": "…", "title": "…" },
  "meta": { "pagination": { "nextCursor": "…", "limit": 20 } }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "statusCode": 400,
    "details": { "context": "body", "issues": [ … ] },
    "requestId": "e6a1f2c0-…"
  }
}
```

- `requestId` always present; echoed in the `X-Request-Id` header. An
  incoming `x-request-id` header is honored (tracing).
- Never `send()` raw — use `reply.ok(data, meta?)` /
  `reply.created(data)` / `reply.accepted(data)`.

## Error code catalog

| Code                                          | Status | Meaning                                                                                                                                                |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VALIDATION_ERROR`                            | 400    | JSON schema validation failed (`details.issues`)                                                                                                       |
| `INVALID_ID`                                  | 400    | Non-UUID id in a path (PG 22P02 mapped)                                                                                                                |
| `INVALID_CURSOR`                              | 400    | Malformed/tampered pagination cursor                                                                                                                   |
| `INVALID_LIMIT`                               | 400    | limit < 1 or not a number                                                                                                                              |
| `BAD_CONTENT_TYPE`                            | 400    | Unsupported video content type                                                                                                                         |
| `VIDEO_NOT_READY`                             | 400    | Video not transcoded / no HLS output                                                                                                                   |
| `BAD_SEGMENT_PATH`                            | 400    | Segment path fails the whitelist regex                                                                                                                 |
| `PACKAGE_EMPTY`                               | 400    | Simulation package has no questions configured                                                                                                         |
| `BANK_EMPTY`                                  | 400    | No matching questions in the bank                                                                                                                      |
| `SESSION_CLOSED`                              | 400    | Answer saved after submit                                                                                                                              |
| `SESSION_EXPIRED`                             | 400    | Deadline passed; session auto-submitted                                                                                                                |
| `NOT_GRADED`                                  | 400    | Result requested before grading                                                                                                                        |
| `WEBHOOK_SIGNATURE_INVALID`                   | 400    | Payment webhook failed verification                                                                                                                    |
| `OAUTH_NO_EMAIL` / `ACCOUNT_LINKING_CONFLICT` | 400    | OAuth profile issues                                                                                                                                   |
| `EMAIL_TAKEN`                                 | 409    | Duplicate registration email                                                                                                                           |
| `IDEMPOTENCY_KEY_REUSED`                      | 409    | Same Idempotency-Key, different payload                                                                                                                |
| `UNAUTHORIZED`                                | 401    | Missing/invalid access token                                                                                                                           |
| `TOKEN_EXPIRED`                               | 401    | Refresh token expired (or tampered access token)                                                                                                       |
| `TOKEN_REUSE_DETECTED`                        | 401    | Revoked token presented → family revoked                                                                                                               |
| `AUTH_INVALID_CREDENTIALS`                    | 401    | Wrong email/password (same code for unknown email)                                                                                                     |
| `ACCOUNT_LOCKED`                              | 401    | Too many failed logins (exponential lockout)                                                                                                           |
| `EMAIL_NOT_VERIFIED`                          | 403    | Login before email verification                                                                                                                        |
| `CSRF_TOKEN_MISMATCH`                         | 403    | Missing/mismatched CSRF token on mutation                                                                                                              |
| `ENROLLMENT_REQUIRED`                         | 403    | Streaming a paid-lesson video without enrollment                                                                                                       |
| `PAYMENT_REQUIRED`                            | 403    | Enrolling a paid course without payment                                                                                                                |
| `NOT_ROOM_MEMBER`                             | 403    | Chat room access without membership                                                                                                                    |
| `ATTEMPT_LIMIT_REACHED`                       | 403    | Simulation attempt limit hit or retake cooldown active (`details`: `{attemptsUsed, maxAttempts, retryAfter?}`; `retryAfter` = ISO timestamp or `null`) |
| `IMPORT_TOO_LARGE`                            | 400    | Bulk question import exceeds the 2000-row cap                                                                                                          |
| `TRYOUT_NOT_STARTED`                          | 403    | Scheduled tryout started before `scheduledAt` (`details.startsAt`)                                                                                     |
| `TRYOUT_EXPIRED`                              | 403    | Scheduled tryout started after `closesAt` (`details.closesAt`)                                                                                         |
| `COUPON_INVALID`                              | 400    | Unknown coupon code or coupon not valid for this course                                                                                                |
| `COUPON_EXPIRED`                              | 400    | Coupon past `expiresAt`                                                                                                                                |
| `COUPON_EXHAUSTED`                            | 400    | Coupon usage limit reached                                                                                                                             |
| `NOT_FOUND`                                   | 404    | Unknown route OR unknown resource (ownership-scoped reads return 404 to hide existence)                                                                |
| `TOO_MANY_REQUESTS`                           | 429    | Rate limited (`Retry-After` header set)                                                                                                                |
| `INTERNAL_ERROR`                              | 500    | Unexpected — internals never leaked                                                                                                                    |

Add new codes to this table in the same PR (checklist item).

## Authentication & CSRF

- Access token: httpOnly cookie `access_token` (JWT HS256, 15 min, claims
  include roles + permissions — zero-DB authorization).
- Refresh token: httpOnly cookie `refresh_token` (opaque, rotated on every
  refresh; reuse detection revokes the whole session family).
- CSRF: `csrf_token` cookie + `x-csrf-token` header must match on mutating
  methods. Webhook endpoints opt out via `config: { csrf: false }`.
- Full details: [SECURITY.md](./SECURITY.md).

## Cursor pagination

- Query params: `limit` (1–100, default 20) and `cursor` (opaque).
- Response: `data` = page rows, `meta.pagination.nextCursor` = cursor for
  the next page or `null` when there are no more rows.
- Ordering is stable keyset: `(created_at DESC, id DESC)`; cursors are
  base64url(JSON) of the last row's keys — tampering → `INVALID_CURSOR`.
- Client pattern: request `?limit=N`; if `nextCursor` is non-null, request
  `?limit=N&cursor=<nextCursor>`. Never page by `page` numbers.
- Rationale: [docs/adr/0002-cursor-pagination.md](../adr/0002-cursor-pagination.md).

## Idempotency-Key

Send `Idempotency-Key: <client-generated>` on mutating requests that create
resources (e.g. payment orders):

- First request executes; response cached in Redis for 24 h (namespaced by
  actor/IP).
- Retry with the SAME key + SAME payload → the stored response is replayed
  (no side effects).
- Same key + DIFFERENT payload → `409 IDEMPOTENCY_KEY_REUSED`.
- Server errors (5xx) are never cached.
- Redis down → idempotency is best-effort (request proceeds normally).
- Rationale: [docs/adr/0004-idempotency-keys.md](../adr/0004-idempotency-keys.md).

## Rate limiting

- Per-route buckets (each route has its own counter — a login burst never
  blocks the catalog).
- `429 TOO_MANY_REQUESTS` with `Retry-After` seconds on the response.
- Redis-backed with an in-memory fallback — rate limiting is NEVER silently
  disabled (degradation only swaps the store).
- Known defaults: login 5/min, forgot-password 5/min, refresh 20/min,
  lesson progress 60/min, video master 120/min, video segments 300/min.
  Global default 100 req/s/route when a route does not override.

## Soft-delete semantics

- `DELETE` on deletable resources (courses, questions, packages, videos,
  lessons) is a soft delete: sets `deleted_at`, keeps the row.
- Soft-deleted rows disappear from every read (repositories apply
  `notDeleted()`) and from question-bank picking.
- `POST /:id/restore` (admin/owner) flips it back; restoring an active row
  is a no-op success (`alreadyActive: true`).
- Rationale: [docs/adr/0003-transactions-soft-deletes.md](../adr/0003-transactions-soft-deletes.md).

## Conventions by area

- **Ownership**: resource mutations check creator/owner or admin; cross-user
  reads (orders, sessions, progress) are scoped and return 404 for other
  users (no existence leak).
- **Video streaming**: `master.m3u8` / `segments/*` return 307 redirects to
  presigned S3 URLs after an auth/enrollment gate ([VIDEO-HLS.md](../services/VIDEO-HLS.md)).
- **WebSocket chat**: `/api/v1/chat/ws` — protocol in
  [CHAT-WEBSOCKET.md](../services/CHAT-WEBSOCKET.md).
- **Payments**: webhook endpoints are signature-authenticated and idempotent
  ([PAYMENTS.md](../services/PAYMENTS.md)).
