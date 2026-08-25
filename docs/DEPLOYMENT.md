# Deployment

CI/CD: Jenkins → Docker images → SSH → docker compose on the VPS. Also covers
local prod-like runs. Operational details (backup, incidents): [RUNBOOK.md](./RUNBOOK.md).

## Docker images

| Image                    | Build                                                           | Purpose                                |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------- |
| `ayo-snbt-api`           | `Dockerfile` (4 stages: deps-prod → deps-dev → build → runtime) | API + worker (no ffmpeg)               |
| `ayo-snbt-worker-ffmpeg` | `docker/Dockerfile.worker-ffmpeg`                               | worker WITH ffmpeg/ffprobe (transcode) |

Why 4 stages: the build stage needs dev dependencies (TypeScript compiler);
the runtime stage copies only prod deps + `dist/`. Never merge those stages —
the build would break (tsc missing) or the image would balloon (dev deps).

## Compose

- `compose.dev.yml` — full local stack (infra + api + worker + grafana);
  Postgres on host :5433, PgBouncer :6432, Mailpit :1025/:8025.
- `compose.prod.yml` — API + worker + infra, secrets via env vars
  (never committed); validate with `docker compose -f compose.prod.yml config --quiet`.

## Jenkins pipeline (Jenkinsfile)

Stages (fail-fast, artifacts preserved):

1. **Install** — npm ci (npm 10, matching the committed lockfile)
2. **Lint** — `npm run lint`
3. **Typecheck** — `npm run typecheck`
4. **Unit tests** — `npm test`
5. **Integration tests** — compose stack (postgres, pgbouncer, redis, mongo, minio, mailpit)
6. **Build** — `npm run build`
7. **Trivy scan** — container image vulnerability scan
8. **Deploy (SSH)** — copy compose + env → VPS → run migration container
   (`node dist/shared/db/migrate-runner.js`) → `docker compose up -d` → rollout
9. **Smoke** — `curl /health` + `curl /ready`

Migrations ALWAYS run before the new API starts (old code + new schema
compatibility window).

## HAProxy (`docker/haproxy.cfg`)

- Frontend :80 with a **stick-table rate limit** (first line of defense)
- Backend roundrobin over API replicas; health checks drain replicas whose
  `/ready` fails
- Stats UI on :8404

## Scaling

```bash
docker compose -f compose.prod.yml up -d --scale api=4   # more replicas
docker compose -f compose.prod.yml up -d --scale worker=2 # more queue consumers
```

Capacity math and levers: [SCALING.md](./SCALING.md).

## Secrets management

- `.env`, `.env.production`, `*.local` are gitignored — never commit.
- `assertSecureInProduction` refuses to boot with dev defaults in
  `NODE_ENV=production` (JWT secret, minioadmin creds, dev DB URLs).
- Rotate `JWT_ACCESS_SECRET` carefully: refresh tokens are opaque (hashed
  rows) so rotation invalidates only access tokens (short TTL); document the
  maintenance window in the runbook.

## Rollback

1. `docker compose -f compose.prod.yml up -d --scale api=0` (drain)
2. `git checkout <previous-commit>` on the release tag, rebuild via Jenkins
   (or `docker compose build` on the VPS)
3. Migrations: only downgrade when the previous schema is compatible — prefer
   forward-fix; see [RUNBOOK.md](./RUNBOOK.md) incident notes.
