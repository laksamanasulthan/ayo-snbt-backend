# 0002 — Cursor (keyset) pagination with opaque cursors

- Status: accepted
- Date: 2025 (soft-delete refactor phase)

## Context

List endpoints (catalog, question bank, my sessions, my orders) needed
pagination. Options considered:

1. **Offset** (`?page=N&limit=20`): O(N) skip cost, and inserts/deletes
   between pages shift rows → duplicates or gaps; also unstable under
   high write rates.
2. **Keyset (cursor)** (`?cursor=…&limit=20`): stable under concurrent
   writes, index-friendly (`created_at, id`), O(log n) per page.

The target is 100k req/s with heavy catalog reads — offset pagination does
not scale (deep pages, cache churn).

## Decision

- Every paginated list uses keyset pagination with a composite ordering
  `(created_at DESC, id DESC)` — `id` is the tie-breaker.
- Cursors are opaque: `base64url(JSON(keys))` of the last row's ordering
  keys (`shared/pagination.ts`: `encodeCursor`/decodeCursor/keysetCondition).
- Contract: `meta.pagination = { nextCursor, limit }`; `nextCursor` is
  `null` when the page is not full (no more rows).
- `limit` clamped to [1, 100]; malformed cursors → `400 INVALID_CURSOR`.
- The keyset predicate must use **fully-qualified column names** when the
  query JOINs other tables (a real bug: unqualified `created_at`/id` was
  ambiguous with the users JOIN → SQL error on page 2+).

## Consequences

- No duplicates/gaps under concurrent writes; stable pages.
- Cursors leak nothing (opaque) and are tamper-resistant (validated shape).
- Clients cannot jump to arbitrary pages (acceptable for this product; the
  frontend only walks forward/back via cursors).
- Every new list endpoint must follow the same pattern — repositories and
  routes get it for free via `buildPage`/keysetCondition.
