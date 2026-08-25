# Getting Started

Everything you need to run Ayo-SNBT backend. There are **two ways to run**;
the Docker mode is **recommended** for most developers.

---

## 1. Two ways to run — choose your mode

| Aspect                           | ✅ **Docker mode (recommended)**   | ⚠️ **Local mode (alternative)**              |
| -------------------------------- | ---------------------------------- | -------------------------------------------- |
| **API**                          | container (polling watcher, :3000) | host with `npm run dev` (tsx watch)          |
| **Worker**                       | container (polling watcher)        | host with `npm run dev:worker` (tsx watch)   |
| **Infra** (DB/Redis/Mongo/MinIO) | all containers                     | all containers                               |
| **Hot reload**                   | ✅ polling watcher in-container    | ✅ tsx watch                                 |
| **Debug / breakpoints**          | ⚠️ harder (node inspector port)    | ✅ native Node.js debug                      |
| **Reproducibility**              | ✅ matches prod                    | ⚠️ depends on host OS/Node version           |
| **Setup time**                   | fast (one compose up)              | same infra + extra npm install + ffmpeg step |
| **ffmpeg binary**                | included in the Docker build       | must install manually                        |

**Choose Docker mode** for: everyday development, CI, reproducing prod issues,
onboarding new team members — it now comes with hot reload too.

**Choose local mode** when: you want the most direct Node.js debugging (or an
IDE debugger that attaches to the host process) and prefer no container
layers around the app process.

---

## 2. Prerequisites

- **Node.js ≥ 22** (for both modes — you need npm for `db:migrate`/seed scripts)
- **Docker Desktop** (or Podman with compose support)
- **npm** (the lockfile was generated with **npm 10** — see gotcha below)

---

## 3. Install dependencies (shared)

```bash
npm install
```

> **If you plan to use local mode** (alternative), also install the ffmpeg
> binary manually (the `.npmrc` file sets `ignore-scripts=true`, which
> prevents automatic download):
>
> ```bash
> node node_modules/ffmpeg-static/install.js
> ```
>
> In Docker mode the ffmpeg binary is bundled inside the container image, so
> the manual install is **not needed**.

---

## 4. Environment

```bash
cp .env.example .env
```

The defaults match `compose.dev.yml` exactly — no edits needed. Full reference:
[docs/guides/ENVIRONMENT.md](./ENVIRONMENT.md).

---

## 5. ✅ Mode A — Docker (recommended): full stack in containers

```bash
# 1. Build the dev images and start everything (infra + API + worker + observability):
docker compose -f compose.dev.yml up -d --build

# 2. Check that all services are healthy:
docker compose -f compose.dev.yml ps

# 3. Apply migrations and seed RBAC:
npm run db:migrate
npm run db:seed
```

**What you get:**

- API at `http://localhost:3000` — runs **scripts/dev.mjs** (a polling file
  watcher) inside the container; code changes reload automatically
- Worker consuming BullMQ queues (email, grading, transcode, payment) — also
  polling watcher
- Source is bind-mounted (`.:/app`); the container keeps its own Linux
  `node_modules` (anonymous volume — host modules are never used)
- Postgres :5433, PgBouncer :6432, Redis :6379, Mongo :27017, MinIO :9000/9001, Mailpit :1025/:8025
- Prometheus :9090, Grafana :3001

**Hot reload:** save a source file → `scripts/dev.mjs` (a simple polling
file watcher) detects the change and restarts the server inside the container
automatically. No rebuild needed for code changes.

> **Why a polling watcher?** Docker Desktop (Windows/macOS) bind mounts use
> VirtioFS / gRPC-FUSE, which does **not** deliver `fs.watch` events for
> host-side changes into the container — so tsx watch and `node --watch`
> silently never restart. The polling watcher (`fs.watchFile`) works on
> every mount technology. If you edit `scripts/dev.mjs` itself, restart the
> container (`docker compose restart api worker`) to pick up the change.

**Rebuild only when dependencies change** (package.json / package-lock.json):

```bash
docker compose -f compose.dev.yml up -d --build api worker
```

> **Note:** `docker/Dockerfile.dev` is DEV-only. Production always uses the
> multi-stage `Dockerfile` (built `dist/`, no dev dependencies) via
> `compose.prod.yml` — see [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## 6. ⚠️ Mode B — Local app (alternative): infra in Docker, app on host

Use this when you want tsx watch hot-reload or native Node.js debugging.

```bash
# 1. Start only the infrastructure:
docker compose -f compose.dev.yml up -d postgres pgbouncer redis mongo minio minio-init mailpit

# 2. Start the API (tsx watch — hot reload):
npm run dev

# 3. In a second terminal, start the worker:
npm run dev:worker
```

The API and worker now run on your host (not in containers). The environment
variables in `.env` point at localhost ports (e.g. `DATABASE_URL` →
`localhost:6432`), which is exactly what the compose stack exposes.

---

## 7. Verify it's running

```bash
curl http://localhost:3000/health      # liveness
curl http://localhost:3000/ready       # readiness + degradation snapshot
open http://localhost:3000/docs        # Scalar API reference
curl http://localhost:3000/api/v1/courses   # public catalog (empty initially)
```

Useful UIs:

| URL                   | What                                                |
| --------------------- | --------------------------------------------------- |
| http://localhost:8025 | Mailpit — dev email inbox                           |
| http://localhost:9001 | MinIO console — object storage                      |
| http://localhost:3001 | Grafana — dashboards (if prometheus+grafana are up) |

---

## 8. Run the tests

```bash
npm test                    # unit suite (no infra needed)
npm run test:integration    # integration suite (compose stack must be up)
```

Full campaign description: [docs/guides/TESTING.md](./TESTING.md).

---

## 9. Known gotchas

| #   | Gotcha                                                     | Workaround                                                                                                                                                           |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ignore-scripts=true` in `.npmrc`                          | Run `node node_modules/ffmpeg-static/install.js` after install (only needed for local mode — Docker mode bundles it)                                                 |
| 2   | npm 11 vs npm 10 lockfile drift                            | Regenerate the lockfile with npm 10: `docker run --rm -v "$PWD:/app" -w /app node:22-alpine npm install --package-lock-only --no-audit --no-fund`                    |
| 3   | Integration tests share the compose DB                     | They TRUNCATE tables and run sequentially (`fileParallelism: false`) — never point them at real data                                                                 |
| 4   | Redis persists between test runs                           | Suites clear rate-limit/lockout/WS buckets in `beforeAll` via `ensureRedisConnected()`; if tests behave oddly, `docker compose restart redis`                        |
| 5   | Redis client rejects commands before connecting            | `enableOfflineQueue: false` is intentional (fail-fast → circuit breaker); cleanup in tests must await the `ready` event first                                        |
| 6   | Postgres 18 image data dir                                 | The volume mounts at `/var/lib/postgresql` (versioned subdirs) — do not pin `/var/lib/postgresql/data`                                                               |
| 7   | PgBouncer tx pooling                                       | `statement_cache_size: 0` in `docker/pgbouncer.ini` is required — do not remove it                                                                                   |
| 8   | `z.coerce.boolean()` turns "false" into true               | Use `boolFromEnv` for boolean env vars (see `src/config/env.ts`)                                                                                                     |
| 9   | Docker Desktop bind mounts don't deliver `fs.watch` events | Dev image uses `scripts/dev.mjs` (polling `fs.watchFile`) instead of tsx watch — works on every mount. Editing `scripts/dev.mjs` itself requires a container restart |

---

## 10. Common tasks

**Add a new slice?** Follow [CONTRIBUTING.md](../../CONTRIBUTING.md) — copy the
shape of `src/modules/questions/` and register in `src/app.ts`.

**Add a table?** Edit the per-slice model file under `src/shared/db/schema/`
(e.g. `courses.ts` for course tables) and re-export it from
`schema/index.ts` → `npm run db:generate` → `npm run db:migrate`.
See [docs/architecture/DATABASE.md](../architecture/DATABASE.md).
→ `npm run db:migrate`. See [docs/architecture/DATABASE.md](../architecture/DATABASE.md).

**Queue a background job?** See [docs/architecture/QUEUEING.md](../architecture/QUEUEING.md) —
`enqueue(QueueName.X, payload, opts)` from any service.

**Debug Redis degradation?** `/ready` shows the per-gate degradation
snapshot (cache/rateLimit/queue/presence). See
[docs/architecture/ARCHITECTURE.md](../architecture/ARCHITECTURE.md).

---

## 11. Troubleshooting

- **API won't boot — "Invalid environment configuration"**: `npm run dev`
  prints the failing env vars; diff your `.env` against `.env.example`.
- **Migrations fail through PgBouncer**: use the direct URL
  (`npm run db:migrate` already does).
- **WebSocket connects then closes with 4001**: auth failed — check the
  `access_token` cookie name (not `asbt_access`) and ticket expiry (120 s).
  See [docs/services/CHAT-WEBSOCKET.md](../services/CHAT-WEBSOCKET.md).
- **Rate limits hit during development**: per-route buckets (e.g. login
  max 5/min) are real — flush with `redis-cli KEYS 'asbt:rl*' | xargs redis-cli DEL`.
  Or restart the Redis container: `docker compose restart redis`.
