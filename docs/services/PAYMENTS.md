# Payments

Orders, provider adapters, webhook idempotency, fulfillment. Slice:
`src/modules/payments/`.

## Order lifecycle

```
create ──► pending ──► paid ──► fulfilled ──► refunded
              │
              └──────────► expired (lazy, after 24 h)
```

- `POST /payments/orders { courseId }`:
  - unknown course → 404; unpublished → 400
  - **free course** → enrolls directly (idempotent), no order
  - **paid course** → creates order (`pending`), returns
    `order.paymentUrl` from the provider
- `GET /payments/orders` / `:id` — user-scoped (other users → 404),
  cursor-paginated. Reading a stale pending order lazily flips it to
  `expired` (24 h).
- `POST /payments/orders/:id/refund` — admin only (`payment:refund`);
  only `paid`/`fulfilled` orders can be refunded; double refund → 400.

## Provider adapters (`provider.ts`)

| Provider (`PAYMENT_PROVIDER`) | Auth                    | Webhook verification                                                            |
| ----------------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| `mock` (default)              | —                       | accepts `order_number` (dev only; `/payments/mock/pay/:orderNumber` marks paid) |
| `midtrans`                    | Basic auth (server key) | SHA512(`order_id + status_code + gross_amount + serverKey`)                     |
| `xendit`                      | Basic auth (secret key) | `x-callback-token` header == `XENDIT_CALLBACK_TOKEN`                            |

`createPayment` calls providers with `retryWithBackoff` (3 attempts,
exponential + jitter).

## Webhooks

`POST /payments/webhook/midtrans` · `POST /payments/webhook/xendit` ·
`POST /payments/mock/pay/:orderNumber` (dev)

Flow (`handleWebhook`):

1. **Verify signature** — failure → `400 WEBHOOK_SIGNATURE_INVALID`.
2. **Find order by order number** — missing → 404.
3. **Idempotency**: `payment_events.event_id` unique per order — a replay
   returns `processed: false` and does NOTHING (state machine untouched).
4. Non-paid events (pending/denied) → `processed: true`, order state kept.
5. Paid events on `created/pending` → `paid` + enqueue fulfillment job
   (`jobId: "pay-fulfill-" + orderId` dedupe). Already advanced orders
   (`paid/fulfilled/refunded`) are no-ops.

## Fulfillment (`processPaymentJob`)

1. Skip unless the order is exactly `paid` (guards double-processing).
2. Enroll the user (`onConflictDoNothing` — idempotent).
3. Queue the payment-receipt email (amount formatted id-ID).
4. Mark `fulfilled`, emit `order.fulfilled` (cache invalidation hook).

## Dev flow (mock provider)

```bash
# create order for a paid course (PAYMENT_PROVIDER=mock default)
curl -X POST localhost:3000/api/v1/payments/orders -H 'cookie: access_token=…; csrf_token=…' -H 'x-csrf-token: …' -H 'content-type: application/json' -d '{"courseId":"…"}'
# simulate the provider callback
curl -X POST localhost:3000/api/v1/payments/mock/pay/<ORDER_NUMBER>
# then run the worker to fulfill, or check status:
curl localhost:3000/api/v1/payments/orders/<ORDER_ID> -H 'cookie: access_token=…'
```

## Idempotency-Key

Order creation is the primary consumer of the `Idempotency-Key` header —
replays return the SAME order (see [API-CONVENTIONS.md](../architecture/API-CONVENTIONS.md)
and [docs/adr/0004-idempotency-keys.md](../adr/0004-idempotency-keys.md)).

## Testing

`tests/integration/payments-edge.test.ts` covers: lazy expiry, signature
rejection, unknown orders, eventId dedupe (service + route), non-paid events,
fulfill guards (skip non-paid, no double enrollment), refund state machine,
cursor pagination, admin-only refund.
