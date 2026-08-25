# Ayo-SNBT Backend — Documentation

Simulation-based SNBT exam-prep platform backend. This is the entry point for
all project documentation — pick your reading path below.

## Reading paths

| You are…                         | Start here                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **New backend developer**        | [GETTING-STARTED.md](./GETTING-STARTED.md) → [ARCHITECTURE.md](./ARCHITECTURE.md) → [CONTRIBUTING.md](../CONTRIBUTING.md)                   |
| **Contributor adding a feature** | [CONTRIBUTING.md](../CONTRIBUTING.md) → [API-CONVENTIONS.md](./API-CONVENTIONS.md) → domain doc for your slice                              |
| **Code reviewer**                | [CONTRIBUTING.md](../CONTRIBUTING.md) → [ARCHITECTURE.md](./ARCHITECTURE.md) → [docs/adr/](./adr/)                                          |
| **Ops / on-call**                | [RUNBOOK.md](./RUNBOOK.md) → [DEPLOYMENT.md](./DEPLOYMENT.md) → [OBSERVABILITY.md](./OBSERVABILITY.md) → [ENVIRONMENT.md](./ENVIRONMENT.md) |
| **Performance / capacity work**  | [SCALING.md](./SCALING.md) → [load/](../load/README.md)                                                                                     |
| **Writing or running tests**     | [TESTING.md](./TESTING.md)                                                                                                                  |

## Document map

| Doc                                        | What it covers                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| [GETTING-STARTED.md](./GETTING-STARTED.md) | Local environment setup, compose stack, running API/worker/tests, known gotchas     |
| [ARCHITECTURE.md](./ARCHITECTURE.md)       | Vertical slices, request lifecycle, shared kernel, degradation, event bus, glossary |
| [API-CONVENTIONS.md](./API-CONVENTIONS.md) | JSON envelope, error code catalog, pagination, idempotency, rate limiting, CSRF     |
| [DATABASE.md](./DATABASE.md)               | Table inventory, migrations, PgBouncer, soft-deletes, audit trail                   |
| [QUEUEING.md](./QUEUEING.md)               | BullMQ queues, workers, job lifecycle, backoff, degradation behavior                |
| [SECURITY.md](./SECURITY.md)               | Auth flows, refresh rotation, lockout, RBAC, OAuth2, cookies                        |
| [CHAT-WEBSOCKET.md](./CHAT-WEBSOCKET.md)   | WS gateway protocol, rooms, presence, rate limits, error codes                      |
| [VIDEO-HLS.md](./VIDEO-HLS.md)             | Upload flow, ffmpeg transcode pipeline, streaming gates, segment security           |
| [PAYMENTS.md](./PAYMENTS.md)               | Order lifecycle, provider adapters, webhook idempotency, fulfillment                |
| [ENVIRONMENT.md](./ENVIRONMENT.md)         | Every environment variable, defaults, prod notes                                    |
| [DEPLOYMENT.md](./DEPLOYMENT.md)           | Docker builds, compose.prod, Jenkins pipeline, HAProxy, secrets                     |
| [OBSERVABILITY.md](./OBSERVABILITY.md)     | Logging, request IDs, Prometheus metrics, Grafana, health endpoints                 |
| [TESTING.md](./TESTING.md)                 | Unit + integration campaign, how to run, infrastructure notes                       |
| [SCALING.md](./SCALING.md)                 | 100k req/s path, capacity math, levers                                              |
| [RUNBOOK.md](./RUNBOOK.md)                 | Service inventory, deploy, backup/restore, incidents                                |
| [adr/](./adr/)                             | Architecture Decision Records (imports, pagination, transactions, idempotency)      |
| [../CONTRIBUTING.md](../CONTRIBUTING.md)   | Slice anatomy, conventions, PR checklist                                            |
| [../load/README.md](../load/README.md)     | k6 load scenarios                                                                   |

## Documentation policy

- **Docs change with code.** Every PR that touches behavior must update the
  relevant doc in the same PR (CONTRIBUTING.md checklist item).
- **Decisions go to ADRs.** Non-obvious architectural choices are recorded in
  [docs/adr/](./adr/) with context, decision, and consequences — read them
  before refactoring the areas they cover.
- **Never paste secrets.** Docs use defaults/placeholders only (see
  [ENVIRONMENT.md](./ENVIRONMENT.md)).
- **Links are checked.** `npm run docs:check` resolves every relative link and
  runs prettier over markdown — keep it green.
