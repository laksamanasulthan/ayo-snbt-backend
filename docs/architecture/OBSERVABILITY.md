# Observability

Logging (pino), request tracing (request IDs), Prometheus metrics, health/
readiness, and Grafana. Ops procedures: [RUNBOOK.md](../guides/RUNBOOK.md).

## Logging

- pino JSON logs (`LOG_LEVEL`), pretty-printed in dev via pino-pretty.
- Every request carries `requestId` (honors incoming `x-request-id`),
  echoed in the `X-Request-Id` header AND the JSON envelope
  (`error.requestId` / `meta`).
- Structured fields on domain events: `sessionId`, `orderId`, `videoId`,
  `jobId` — grep by these, not by message text.

Example trace (grep by request id):

```bash
docker compose logs api | grep "requestId":\"e6a1f2c0-…"
```

## Metrics (`shared/metrics`)

Prometheus exposition at `/metrics` (HTTP scrape; Grafana datasource points
at Prometheus :9090).

| Metric family          | Type      | Meaning                                                          |
| ---------------------- | --------- | ---------------------------------------------------------------- |
| HTTP request counter   | Counter   | status code, method, route                                       |
| HTTP latency histogram | Histogram | buckets per route                                                |
| Degradation gauges     | Gauge     | per-gate state (cache/rateLimit/queue/presence) — collected live |
| Queue depth gauges     | Gauge     | BullMQ job counts, polled every 15 s                             |

Degradation gauges let dashboards alert BEFORE users feel Redis outages
(gates flip well ahead of request failures).

## Health & readiness

| Endpoint      | Auth | Semantics                                                       |
| ------------- | ---- | --------------------------------------------------------------- |
| `GET /health` | none | liveness: process up (load-balancer check)                      |
| `GET /ready`  | none | readiness: dependency snapshot incl. per-gate degradation state |

HAProxy drains replicas whose `/ready` fails.

## Grafana

- Provisioned dashboards under `docker/grafana/` (datasources, provisioning,
  `ayo-snbt.json`).
- Local: start `prometheus` + `grafana` services in
  `compose.dev.yml` → http://localhost:3001.

## Alerts worth having (runbook-driven)

1. `/ready` failing on a gate (degradation gauge ≠ healthy) — Redis incident
2. Queue depth > threshold (e.g. grading backlog) — worker down/backpressure
3. 5xx rate spike per route — deployment or data issue
4. `TOKEN_REUSE_DETECTED` spike — possible credential theft wave
5. Webhook signature failures spike — provider key rotation issue
