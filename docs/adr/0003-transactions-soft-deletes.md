# 0003 — Transactions (withTx) + soft deletes + audit trail

- Status: accepted
- Date: 2025 (soft-delete refactor phase)

## Context

Mutating flows (question + options replace, delete/restore + audit + event,
payment webhook + dedupe row) need multi-statement atomicity. Deletes across
six tables (users, courses, lessons, videos, questions, simulation_packages)
needed to be recoverable and auditable for a growing team.

## Decision

### Transactions

- `shared/db/transaction.ts` exports `withTx(fn)`: runs `fn(tx)` inside
  `db.transaction`; services use it for any multi-statement write.
- **Visibility rule**: inside the transaction, read back via the SAME `tx`
  connection — other pool connections cannot see uncommitted rows (a real
  bug: `getById` after insert returned stale data).
- Rollback is all-or-nothing; a failing step (e.g. PG NOT NULL violation)
  reverts earlier steps (covered by an integration test).

### Soft deletes

- Deletable tables carry `deleted_at`; reads go through repositories that
  apply `notDeleted()` (`isNull(deleted_at)`) everywhere.
- Partial unique indexes keep uniqueness among active rows (e.g. slug,
  email) so restore is always possible.
- `DELETE` → soft delete + audit + cache version bump + domain event;
  `POST /:id/restore` (admin/owner) → clear + audit + event. Restoring an
  active row is a no-op success.
- Child rows that follow the parent (question_options) have NO own
  `deleted_at` — reads filter at the parent level.

### Audit trail

- `audit({ action, resourceType, resourceId, before?, after? })` writes to
  `audit_logs` and reads actor/ip/requestId from the request context
  (AsyncLocalStorage) — services never thread identity manually; background
  jobs set the actor explicitly.

## Consequences

- Atomic, recoverable, explainable mutations — safe for a growing team.
- Every new mutation must follow: transaction → repo notDeleted filters →
  audit → event. Enforcement is by convention (CONTRIBUTING checklist) plus
  integration tests that assert rollback and soft-delete visibility.
