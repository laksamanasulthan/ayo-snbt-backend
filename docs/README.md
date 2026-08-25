# Ayo-SNBT Backend — Documentation

Simulation-based SNBT exam-prep platform backend. This is the entry point for
all project documentation — pick your reading path below.

## Reading paths

| You are…                         | Start here                                                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New backend developer**        | [guides/GETTING-STARTED.md](./guides/GETTING-STARTED.md) → [architecture/ARCHITECTURE.md](./architecture/ARCHITECTURE.md) → [../CONTRIBUTING.md](../CONTRIBUTING.md)                                            |
| **Contributor adding a feature** | [../CONTRIBUTING.md](../CONTRIBUTING.md) → [architecture/API-CONVENTIONS.md](./architecture/API-CONVENTIONS.md) → domain doc for your slice                                                                     |
| **Code reviewer**                | [../CONTRIBUTING.md](../CONTRIBUTING.md) → [architecture/ARCHITECTURE.md](./architecture/ARCHITECTURE.md) → [adr/](./adr/)                                                                                      |
| **Ops / on-call**                | [guides/RUNBOOK.md](./guides/RUNBOOK.md) → [guides/DEPLOYMENT.md](./guides/DEPLOYMENT.md) → [architecture/OBSERVABILITY.md](./architecture/OBSERVABILITY.md) → [guides/ENVIRONMENT.md](./guides/ENVIRONMENT.md) |
| **Performance / capacity work**  | [architecture/SCALING.md](./architecture/SCALING.md) → [../load/README.md](../load/README.md)                                                                                                                   |
| **Writing or running tests**     | [guides/TESTING.md](./guides/TESTING.md)                                                                                                                                                                        |
| **Product / roadmap questions**  | [product/PRODUCT-ROADMAP.md](./product/PRODUCT-ROADMAP.md) → [product/FEATURE-SPECS.md](./product/FEATURE-SPECS.md)                                                                                             |

## Document map

### 🧭 Guides — how to run, work and operate the platform

| Doc                                               | What it covers                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| [GETTING-STARTED.md](./guides/GETTING-STARTED.md) | Setup, **Docker mode (recommended, hot reload)** vs local host mode, gotchas |
| [TESTING.md](./guides/TESTING.md)                 | Unit + integration campaign, how to run, infrastructure notes                |
| [ENVIRONMENT.md](./guides/ENVIRONMENT.md)         | Every environment variable, defaults, prod notes                             |
| [DEPLOYMENT.md](./guides/DEPLOYMENT.md)           | Docker builds, compose.prod, Jenkins pipeline, HAProxy, secrets              |
| [RUNBOOK.md](./guides/RUNBOOK.md)                 | Service inventory, deploy, backup/restore, incidents                         |

### 🏗️ Architecture — how the system is built

| Doc                                                     | What it covers                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](./architecture/ARCHITECTURE.md)       | Vertical slices, request lifecycle, shared kernel, degradation, event bus       |
| [API-CONVENTIONS.md](./architecture/API-CONVENTIONS.md) | JSON envelope, error code catalog, pagination, idempotency, rate limiting, CSRF |
| [DATABASE.md](./architecture/DATABASE.md)               | Table inventory, migrations, PgBouncer, soft-deletes, audit trail               |
| [QUEUEING.md](./architecture/QUEUEING.md)               | BullMQ queues, workers, job lifecycle, backoff, degradation behavior            |
| [SECURITY.md](./architecture/SECURITY.md)               | Auth flows, refresh rotation, lockout, RBAC, OAuth2, cookies                    |
| [OBSERVABILITY.md](./architecture/OBSERVABILITY.md)     | Logging, request IDs, Prometheus metrics, Grafana, health endpoints             |
| [SCALING.md](./architecture/SCALING.md)                 | Scaling guide: mental model, 7 levers, capacity math, surge runbook, triage     |
| [adr/](./adr/)                                          | Architecture Decision Records (imports, pagination, transactions, idempotency)  |

### 🔌 Services — external system deep dives

| Doc                                               | What it covers                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| [CHAT-WEBSOCKET.md](./services/CHAT-WEBSOCKET.md) | WS gateway protocol, rooms, presence, rate limits, error codes            |
| [VIDEO-HLS.md](./services/VIDEO-HLS.md)           | Upload flow, ffmpeg transcode pipeline, streaming gates, segment security |
| [PAYMENTS.md](./services/PAYMENTS.md)             | Order lifecycle, provider adapters, webhook idempotency, fulfillment      |

### 📋 Product — what we build and why

| Doc                                                | What it covers                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| [PRODUCT-ROADMAP.md](./product/PRODUCT-ROADMAP.md) | Backend-first feature roadmap: tiers M/A/N, sprints, DoD, anti-features    |
| [FEATURE-SPECS.md](./product/FEATURE-SPECS.md)     | Every feature: endpoints, flow, frontend UI, constraints (built + planned) |
| [FRONTEND-PLAN.md](./product/FRONTEND-PLAN.md)     | Frontend plan (DEFERRED — spec only)                                       |
| [INVESTIGATIONS.md](./product/INVESTIGATIONS.md)   | Non-feature engineering investigations (e.g. MongoDB high-CPU)             |

### 📎 Root-level

| Doc                                      | What it covers                           |
| ---------------------------------------- | ---------------------------------------- |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Slice anatomy, conventions, PR checklist |
| [../load/README.md](../load/README.md)   | k6 load scenarios                        |

## Documentation policy

- **Docs change with code.** Every PR that touches behavior must update the
  relevant doc in the same PR (CONTRIBUTING.md checklist item).
- **Decisions go to ADRs.** Non-obvious architectural choices are recorded in
  [adr/](./adr/) with context, decision, and consequences — read them
  before refactoring the areas they cover.
- **Never paste secrets.** Docs use defaults/placeholders only (see
  [guides/ENVIRONMENT.md](./guides/ENVIRONMENT.md)).
- **Links are checked.** `npm run docs:check` resolves every relative link and
  runs prettier over markdown — keep it green.
