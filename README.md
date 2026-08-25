# Ayo-SNBT Backend

Simulation-based SNBT (Seleksi Nasional Berdasarkan Tes) exam-prep platform backend — a flagship, horizontally scalable API engineered toward a 100k req/s ceiling.

## Tech Stack

| Layer            | Technology                                                         |
| ---------------- | ------------------------------------------------------------------ |
| API framework    | Fastify 5 + TypeScript (strict)                                    |
| ORM / migrations | Drizzle ORM + drizzle-kit                                          |
| Database         | PostgreSQL 18 behind **PgBouncer** (transaction pooling)           |
| Cache / queue    | Redis 7 + **BullMQ 5** (exponential backoff)                       |
| Chat             | MongoDB (WebSocket gateway via @fastify/websocket)                 |
| Object storage   | S3-compatible (MinIO in dev, AWS/R2/Spaces in prod)                |
| Auth             | Cookie-based JWT access + rotating refresh tokens, OAuth2 (Google) |
| Docs             | OpenAPI 3.0 + **Scalar** at /docs                                  |
| Email            | Nodemailer (Mailpit in dev)                                        |
| Observability    | pino + Prometheus + Grafana                                        |
| CI/CD            | Jenkins + Docker (Trivy scan, SSH deploy)                          |

## Architecture Highlights

- **Vertical slice modules** under `src/modules/` — each owns routes, handlers, services, repositories, schemas, jobs and tests.
- **Standardized JSON envelope** on every response: `{ success, data, meta }` / `{ success: false, error: { code, message, statusCode, requestId } }`.
- **Per-route rate limiting** (Redis sliding-window INCR, in-memory fallback) with `Retry-After` headers; global HAProxy limit as first line.
- **Exponential backoff + full jitter** in BullMQ jobs, outbound retries (`shared/backoff`), Redis reconnects and client retry guidance.
- **Graceful Redis degradation** (`shared/redis/degradation.ts`): circuit breakers per subsystem (cache → DB bypass, rateLimit → memory, queue → outbox/503).
- **RBAC**: roles/permissions seeded in Postgres; claims embedded in the JWT so authorization costs zero DB hits.
- **100k req/s path**: stateless replicas behind HAProxy, layered caching (CDN → HAProxy → in-memory LRU → Redis), async offload via BullMQ, zero-copy S3 uploads/streaming, read replicas (Phase 7), k6 load suite.

## Quick Start (dev)

```bash
cp .env.example .env          # defaults match compose.dev.yml
docker compose -f compose.dev.yml up -d   # infra + api + worker
npm run db:migrate           # apply migrations (direct connection)
npm run db:seed              # seed RBAC roles/permissions

curl http://localhost:3000/health   # liveness
curl http://localhost:3000/ready    # readiness + degradation snapshot
open http://localhost:3000/docs     # Scalar API reference
```

Mailpit UI: http://localhost:8025 · MinIO console: http://localhost:9001 · Grafana: http://localhost:3001

## Local development without Docker

```bash
npm install
npm run dev                  # tsx watch src/server.ts
npm run dev:worker           # tsx watch src/worker.ts
npm test                     # vitest unit suite
```

## Documentation

Full documentation lives in [docs/](docs/README.md) — onboarding, architecture,
API conventions + error codes, database, queueing, security, chat/WS protocol,
video pipeline, payments, environment reference, deployment, observability,
testing, scaling, runbook, and Architecture Decision Records.

## Scripts

| Script                     | Purpose                                 |
| -------------------------- | --------------------------------------- |
| `npm run dev`              | Hot-reload API server                   |
| `npm run build`            | tsc production build to `dist/`         |
| `npm start`                | Run built server                        |
| `npm run typecheck`        | Strict type check                       |
| `npm run lint`             | ESLint                                  |
| `npm test`                 | Vitest unit suite                       |
| `npm run test:integration` | Integration suite (needs compose infra) |
| `npm run docs:check`       | Docs link checker + prettier check      |
| `npm run db:generate`      | Generate migration from Drizzle schema  |
| `npm run db:migrate`       | Apply migrations                        |
| `npm run db:seed`          | Seed RBAC roles/permissions             |

## Production

1. `docker compose -f compose.prod.yml up -d` on the VPS (after Jenkins deploy).
2. Scale API replicas: `docker compose -f compose.prod.yml up -d --scale api=4`. HAProxy balances + health-drains.
3. Set real secrets in `.env.production` — the app refuses to boot with dev defaults in `NODE_ENV=production`.

## Project Layout

```
src/
├── app.ts / server.ts        # Fastify factory + bootstrap (graceful shutdown)
├── config/                   # zod env schema (validated at boot)
├── modules/                  # vertical slices: auth, users, iam, courses, video,
│                             #   questions, simulations, chat, payments, system
│                             #   each slice: routes + service + repository + index
├── shared/                   # cross-cutting kernel:
│   ├── http/                 #   envelope, errors, rate-limit store, idempotency
│   ├── db/                   #   client (PgBouncer), transaction, filters, schema
│   ├── redis/                #   client, circuit breaker, degradation manager
│   ├── cache/                #   cache-aside + version-tagged invalidation
│   ├── queue/ events/        #   BullMQ helpers, typed event bus
│   ├── audit/ context/       #   audit trail, AsyncLocalStorage request context
│   └── auth/ rbac/ backoff/ s3/ mongo/ mail/ metrics/ logger/
tests/                        # vitest unit + integration suites (see docs/TESTING.md)
load/                         # k6 load scenarios (see load/README.md)
docs/                         # full documentation (see docs/README.md)
scripts/                      # dev tooling (docs link checker)
docker/                       # pgbouncer.ini, haproxy.cfg, prometheus.yml, grafana
Jenkinsfile                   # CI/CD pipeline
```

## Roadmap (phases)

| Phase | Scope                                                                    | Status |
| ----- | ------------------------------------------------------------------------ | ------ |
| 0–1   | Scaffold, kernel, envelope, Redis degradation, DB, RBAC seed, docs       | ✅     |
| 2     | Auth (cookies, OAuth2 Google), users, mail, refresh rotation, lockout    | ✅     |
| 3     | Courses/content/questions + HLS video pipeline (ffmpeg worker)           | ✅     |
| 4     | SNBT simulations: timed sessions, auto-submit, grading jobs, leaderboard | ✅     |
| 5     | Live chat: WS gateway + MongoDB                                          | ✅     |
| 6     | Payments: Midtrans/Xendit + webhooks + fulfillment                       | ✅     |
| 7     | HAProxy prod, metrics/Grafana dashboards, k6 load suite, read replicas   | ✅     |
| 8     | CI/CD hardening, security audit, runbook                                 | ✅     |

## License

Private — Ayo-SNBT.
