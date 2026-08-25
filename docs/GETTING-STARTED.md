# Getting Started

Everything you need to run Ayo-SNBT backend locally and understand the setup.

## Prerequisites

- **Node.js ≥ 22** (project uses ESM + NodeNext)
- **Docker Desktop** (or Podman with compose support) — the stack runs
  Postgres 18, PgBouncer, Redis 7, MongoDB 7, MinIO (S3), and Mailpit in
  containers
- npm (the lockfile is generated with **npm 10** — see the gotcha below)

## 1. Install dependencies

```bash
npm install
# .npmrc sets ignore-scripts=true, so the ffmpeg binary is NOT downloaded
# automatically — install it manually once:
node node_modules/ffmpeg-static/install.js
```

## 2. Environment

```bash
cp .env.example .env
```

The defaults in `.env.example` match `compose.dev.yml` exactly — no edits
needed for local development. Full reference:
[docs/ENVIRONMENT.md](./ENVIRONMENT.md).

## 3. Start the infrastructure

```bash
docker compose -f compose.dev.yml up -d postgres pgbouncer redis mongo minio minio-init mailpit
```

Notes:

- Postgres is exposed on host port **5433** (5432 often clashes with a host
  PostgreSQL). PgBouncer listens on **6432** — `DATABASE_URL` goes through
  PgBouncer; `DIRECT_DATABASE_URL` bypasses it (migrations).
- Verify: `docker compose -f compose.dev.yml ps` → all services healthy.

## 4. Migrate + seed

```bash
npm run db:migrate    # drizzle-kit migrate (direct connection)
npm run db:seed       # RBAC roles (3) + permissions (16)
```

## 5. Run the app

```bash
npm run dev            # API on http://localhost:3000 (tsx watch)
npm run dev:worker     # BullMQ worker in a second terminal (tsx watch)
```

Check it:

```bash
curl http://localhost:3000/health      # liveness
curl http://localhost:3000/ready       # readiness + degradation snapshot
open http://localhost:3000/docs        # Scalar API reference
curl http://localhost:3000/api/v1/courses   # public catalog (empty initially)
```

Useful UIs: Mailpit http://localhost:8025 · MinIO http://localhost:9001 ·
Grafana http://localhost:3001 (if prometheus+grafana services are up).

## 6. Run the tests

```bash
npm test                    # unit suite (no infra needed)
npm run test:integration    # integration suite (compose stack must be up)
```

Full campaign description: [docs/TESTING.md](./TESTING.md).

## Known gotchas

| #   | Gotcha                                          | Workaround                                                                                                                                        |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ignore-scripts=true` in `.npmrc`               | Run `node node_modules/ffmpeg-static/install.js` after install                                                                                    |
| 2   | npm 11 vs npm 10 lockfile drift                 | Regenerate the lockfile with npm 10: `docker run --rm -v "$PWD:/app" -w /app node:22-alpine npm install --package-lock-only --no-audit --no-fund` |
| 3   | Integration tests share the compose DB          | They TRUNCATE tables and run sequentially (`fileParallelism: false`) — never point them at real data                                              |
| 4   | Redis persists between test runs                | Suites clear rate-limit/lockout/WS buckets in `beforeAll` via `ensureRedisConnected()`; if tests behave oddly, `docker compose restart redis`     |
| 5   | Redis client rejects commands before connecting | `enableOfflineQueue: false` is intentional (fail-fast → circuit breaker); cleanup in tests must await the `ready` event first                     |
| 6   | Postgres 18 image data dir                      | The volume mounts at `/var/lib/postgresql` (versioned subdirs) — do not pin `/var/lib/postgresql/data`                                            |
| 7   | PgBouncer tx pooling                            | `statement_cache_size: 0` in `docker/pgbouncer.ini` is required — do not remove it                                                                |
| 8   | `z.coerce.boolean()` turns "false" into true    | Use `boolFromEnv` for boolean env vars (see `src/config/env.ts`)                                                                                  |

## Common tasks

**Add a new slice?** Follow [CONTRIBUTING.md](../CONTRIBUTING.md) — copy the
shape of `src/modules/questions/` and register in `src/app.ts`.

**Add a table?** Edit `src/shared/db/schema/index.ts` → `npm run db:generate`
→ `npm run db:migrate`. See [docs/DATABASE.md](./DATABASE.md).

**Queue a background job?** See [docs/QUEUEING.md](./QUEUEING.md) —
`enqueue(QueueName.X, payload, opts)` from any service.

**Debug Redis degradation?** `/ready` shows the per-gate degradation
snapshot (cache/rateLimit/queue/presence). See
[docs/ARCHITECTURE.md](./ARCHITECTURE.md).

## Troubleshooting

- **API won't boot — "Invalid environment configuration"**: `npm run dev`
  prints the failing env vars; diff your `.env` against `.env.example`.
- **Migrations fail through PgBouncer**: use the direct URL
  (`npm run db:migrate` already does).
- **WebSocket connects then closes with 4001**: auth failed — check the
  `access_token` cookie name (not `asbt_access`) and ticket expiry (120 s).
  See [docs/CHAT-WEBSOCKET.md](./CHAT-WEBSOCKET.md).
- **Rate limits hit during development**: per-route buckets (e.g. login
  max 5/min) are real — flush with `redis-cli KEYS 'asbt:rl*' | xargs redis-cli DEL`.
