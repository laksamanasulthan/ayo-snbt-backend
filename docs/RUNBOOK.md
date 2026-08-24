# Ayo-SNBT Operations Runbook

## Service inventory

| Service | Port (host) | Purpose |
| --- | --- | --- |
| API (Fastify) | 3000 | REST + WebSocket gateway |
| Worker (BullMQ) | — | email, grading, transcode, payment fulfillment |
| PgBouncer | 6432 | PostgreSQL transaction pooling |
| PostgreSQL 18 | 5433 | primary database (5432 may clash with host PG) |
| Redis 7 | 6379 | cache, rate limit, queues, presence, degradation |
| MongoDB 7 | 27017 | chat storage |
| MinIO (S3) | 9000/9001 | media (images, videos, HLS) |
| Mailpit | 1025/8025 | dev SMTP + web UI |
| Prometheus | 9090 | metrics scrape |
| Grafana | 3001 | dashboards |
| HAProxy (prod) | 80 / 8404 | LB + stats |

## Deploy (Jenkins-driven)

```bash
# Manual deploy on the VPS
cd /opt/ayo-snbt
docker compose pull
docker compose run --rm api node dist/shared/db/migrate-runner.js   # migrations FIRST
docker compose up -d                                                # app rollout
curl -fsS http://localhost/health && curl -fsS http://localhost/ready
```

## Scale out / in

```bash
docker compose up -d --scale api=4    # HAProxy auto-balances + drains on /ready failure
docker compose up -d --scale api=2    # scale in
docker compose up -d --scale worker=2 # more queue consumers (grading/transcode heavy)
```

## Backup & restore

```bash
# PostgreSQL (run daily via cron)
docker exec ayo-snbt-postgres-1 pg_dump -U ayosnbt -d ayosnbt -Fc > backups/ayosnbt-$(date +%F).dump

# Restore
cat backups/ayosnbt-YYYY-MM-DD.dump | docker exec -i ayo-snbt-postgres-1 pg_restore -U ayosnbt -d ayosnbt

# MongoDB (chat)
docker exec ayo-snbt-mongo-1 mongodump --db ayosnbt_chat --archive > backups/chat-$(date +%F).archive

# Redis — RDB snapshot (cache is rebuildable; presence/rate-limit loss is acceptable)
docker exec ayo-snbt-redis-1 redis-cli BGSAVE

# MinIO — mirror buckets (media is critical; use mc mirror)
mc mirror local/ayosnbt-images backup/ayosnbt-images
```

## Monitoring

- Grafana: RPS, p99 latency, degradation gates, queue depth (dashboard provisioned).
- Prometheus key alerts (alertmanager rules to add):
  - `ayosnbt_degradation_gate_mode != 0` for > 2 min → Redis degraded; API serving from DB.
  - `ayosnbt_queue_depth > 1000` for > 5 min → consumers stuck; check worker logs.
  - `ayosnbt_http_request_duration_seconds p99 > 500ms` for > 5 min → investigate.
  - `rate(ayosnbt_http_requests_total[5m]) == 0` → API down.

## Incident response

### Redis down / full
1. Check `docker logs ayo-snbt-redis-1`; verify `maxmemory` and `INFO memory`.
2. The app **auto-degrades** (verified): cache→DB, rate limits→memory, queue→reject/outbox. `GET /ready` reports gate modes.
3. Redis returns → gates recover automatically after 3 healthy pings (hysteresis).

### Queue backlog
1. `GET /metrics | grep ayosnbt_queue_depth` — identify the queue.
2. Scale workers: `docker compose up -d --scale worker=N`.
3. Check worker logs for job failures (`job failed` entries) — jobs retry with exponential backoff.

### PgBouncer connection exhaustion
1. `docker logs ayo-snbt-pgbouncer-1` — look for `no more connections allowed`.
2. Check `SHOW POOLS;` via `psql -h localhost -p 6432 -U ayosnbt -d pgbouncer`.
3. Raise `default_pool_size` / `max_client_conn` in pgbouncer config, restart pgbouncer.

### API instance unhealthy
1. `/ready` returns non-200 → HAProxy drains the instance automatically.
2. `docker logs <api-container>` for the failure; fix, redeploy via Jenkins.

### Payment webhook replay
1. Idempotency keys (`payment_events.event_id` unique) make replays safe.
2. Verify order state: `SELECT status FROM orders WHERE order_number = '...'`.
3. Manually re-trigger fulfillment: `docker compose exec worker node -e "..."` or via BullMQ dashboard.

## Security checklist (deployed)

- [ ] `NODE_ENV=production` — app refuses dev secrets (assertSecureInProduction).
- [ ] `COOKIE_SECURE=true`, `TRUST_PROXY=true` behind HAProxy.
- [ ] HAProxy stats bound to localhost (or behind VPN).
- [ ] Provider keys: `MIDTRANS_SERVER_KEY`, `XENDIT_SECRET_KEY` in Jenkins credentials / .env.production (never in git).
- [ ] TLS termination at HAProxy/Cloudflare (cookies require Secure + HTTPS).
- [ ] `DOCS_ENABLED` behind admin auth or disabled in production if unwanted.
- [ ] Helmet CSP active (Scalar-safe policy), `frameAncestors 'none'`.
- [ ] OAuth2 uses the plugin's signed state cookie (CSRF-safe) — verify redirects on a fresh browser.

## Runbook links

- Architecture & scale-out: [SCALING.md](./SCALING.md)
- API docs: `GET /docs` (Scalar)
- Load tests: `load/` (k6)
