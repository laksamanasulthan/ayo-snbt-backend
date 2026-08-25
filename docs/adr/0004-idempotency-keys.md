# 0004 — Idempotency-Key header with a Redis replay store

- Status: accepted
- Date: 2025 (resilience phase)

## Context

Clients retry on network failures/timeouts. Without idempotency, a retried
`POST /payments/orders` creates a SECOND order (double charge risk), and
retried mutations duplicate side effects. Idempotency is a hard requirement
for payment-adjacent flows.

## Decision

- Any mutating request may carry `Idempotency-Key: <client-generated>`
  (≤ 128 chars).
- **preHandler**: lookup `asbt:idem:<actor-or-ip>:<key>` in Redis (24 h
  TTL). Hit with the SAME body hash → replay the stored response verbatim
  (no re-execution). Hit with a DIFFERENT body hash → `409
IDEMPOTENCY_KEY_REUSED`.
- **onSend**: cache `{ statusCode, body, requestBodyHash }` — but NEVER
  cache 5xx responses (a failed attempt stays retryable).
- Namespaced by actor (or IP for anonymous) so one user cannot replay
  another's key.
- **Degradation**: Redis down → idempotency is best-effort; the request
  proceeds normally (idempotency is a safety net, never a hard dependency).
- Body hashing uses the parsed body (schema-normalized), so identical
  payloads with different key orders still match.

## Consequences

- Safe client retries for order creation (and any future mutating flow).
- Redis cost: one GET + one SET per idempotent request — negligible.
- Keys live 24 h: clients must generate NEW keys per logical operation and
  reuse the same key only for retries of that operation.
- The catalog/design lives in `shared/http/idempotency.ts`; integration
  tests cover replay, 409 misuse, and 5xx-not-cached.
