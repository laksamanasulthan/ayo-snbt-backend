# Scaling Ayo-SNBT to 100k req/s — Developer Guide

> **Who this is for:** any developer (including juniors) who needs to scale,
> load-test, or debug capacity issues. Read top to bottom the first time;
> afterwards jump straight to [§11 The traffic-surge runbook](#11-the-traffic-surge-runbook-step-by-step)
> when something is on fire.

---

## 1. How to think about scaling (mental model)

A request travels: **client → HAProxy → API replica → (Postgres | Redis | Mongo | S3)**.
Scaling means removing the _narrowest_ bottleneck in that path. The good news:
this backend was built to scale out, so most levers are already in place — your
job is to (a) measure, (b) pull the right lever, (c) verify.

Two kinds of scaling:

- **Vertical** — make one machine bigger (more CPU/RAM). Easy, but hits a
  ceiling fast and is expensive.
- **Horizontal** — add more identical machines behind a load balancer. This is
  the ONLY path to 100k req/s, because a single Node.js process is single
  threaded for JS execution and tops out around 5–10k req/s on typical
  hardware.

**Why can we scale horizontally at all?** Because every API replica is
_stateless_:

- Auth state lives in **cookies (JWTs)** carried by the client — any replica
  can verify them without shared session storage.
- Shared state lives in **Redis** (cache, rate-limit buckets, BullMQ, chat
  presence) — every replica talks to the same Redis.
- Chat **WebSocket connections** are pinned to one replica for their lifetime
  (Redis pub/sub fans messages out to the replica that owns the socket) —
  that's fine: connections, not requests, are pinned.
- All durable data is in Postgres/Mongo/S3 — never in the process.

If you ever add a feature that stores data in a module-level variable and
expects it to survive across requests, you just broke horizontal scaling.
Keep that rule in mind while reviewing code.

**The bottleneck ladder** (check in this order when something is slow):

1. **API CPU** — check `ayosnbt_http_request_duration_seconds` and container CPU.
2. **Database** — check PgBouncer pool saturation and slow queries.
3. **Redis** — check `ayosnbt_degradation_gate_mode` (gates flip BEFORE users feel it).
4. **Queue backlog** — check `ayosnbt_queue_depth` (workers can't keep up).
5. **Network/edge** — bandwidth, rate-limit denials (429s), CDN offload %.

---

## 2. The levers (quick map)

| #   | Lever                                                                  | Impact                                                | Status                                       |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| 1   | **Stateless replicas behind HAProxy**                                  | Linear scale-out; the single biggest lever            | ✅ built                                     |
| 2   | **CDN offload** (static assets, HLS segments, images)                  | 60–80% of media/catalog traffic never reaches the API | ✅ presigned URLs; CDN config at deploy      |
| 3   | **Layered caching** (CDN → HAProxy cache → in-memory LRU → Redis)      | 90%+ read hit rate on catalog/leaderboard             | ✅ Redis cache-aside + single-flight         |
| 4   | **Async offload via BullMQ** (emails, grading, transcode, fulfillment) | Requests return fast; heavy work queued               | ✅ all queues live                           |
| 5   | **Read replicas + PgBouncer tx-pooling**                               | Reads never compete with writes                       | ✅ replica plumbing (`DATABASE_URL_REPLICA`) |
| 6   | **Zero-copy media** (presigned upload/stream)                          | API bandwidth ~0 for video                            | ✅ HLS redirect streaming                    |
| 7   | **Edge + per-route rate limiting**                                     | Survive traffic spikes/abuse                          | ✅ HAProxy global + app per-route            |

Each lever has a full step-by-step section below (§3–§9). **Do them in order**:
replicas first, then caching/offload, then database — each step multiplies the
previous one.

---

## 3. Before you scale: measure (baseline)

Never scale blind. Record a baseline so you can prove a lever helped.

### 3.1 Install k6

```bash
# k6 is NOT an npm dependency — install the binary:
winget install k6  # Windows
brew install k6    # macOS
# or download from https://grafana.com/docs/k6/latest/set-up/install/
```

### 3.2 Run the existing scenarios

The repo ships four k6 scenarios in `load/`:

| File            | Simulates               | Default thresholds          |
| --------------- | ----------------------- | --------------------------- |
| `catalog.js`    | anonymous catalog reads | errors < 0.1%, p99 < 100 ms |
| `authed.js`     | authenticated reads     | errors < 0.1%, p99 < 200 ms |
| `video.js`      | streaming redirects     | errors < 0.1%, p99 < 150 ms |
| `simulation.js` | simulation start/submit | errors < 0.1%, p99 < 250 ms |

```bash
# Against a local dev API:
k6 run load/catalog.js
# Against a deployed stack (through HAProxy, NOT the API port directly —
# you want to measure the real path clients take):
k6 run -e BASE_URL=http://<vps-ip> load/catalog.js
```

k6 prints a summary table: `http_req_duration` (avg/p50/p90/p95/p99),
`http_reqs` (total + rate), and whether thresholds passed. **Save this
output** — it is your baseline.

### 3.3 Baseline template (copy this table)

| Date       | Scenario | Replicas | req/s | p99    | errors | Notes       |
| ---------- | -------- | -------- | ----- | ------ | ------ | ----------- |
| 2026-01-05 | catalog  | 2        | 8 400 | 62 ms  | 0      | 2 vCPU/4 GB |
| 2026-01-05 | authed   | 2        | 5 100 | 141 ms | 0      |             |
|            |          |          |       |        |        |             |

### 3.4 Check live metrics while load-testing

- Prometheus: `http://<vps>:9090`
- Grafana: `http://<vps>:3001` (provisioned dashboard `ayo-snbt.json`)
- Ad-hoc metric queries you will use constantly:

```
# request rate per route
sum(rate(ayosnbt_http_requests_total[1m])) by (route)
# p99 latency per route
histogram_quantile(0.99, sum(rate(ayosnbt_http_request_duration_seconds_bucket[5m])) by (le, route))
# cache health
sum(rate(ayosnbt_cache_hits_total[5m])) / (sum(rate(ayosnbt_cache_hits_total[5m])) + sum(rate(ayosnbt_cache_misses_total[5m])))
# degradation gates (1 = healthy, other values = degraded)
ayosnbt_degradation_gate_mode
# queue backlog
ayosnbt_queue_depth
```

**Golden rule:** if a metric doesn't exist for what you're changing, you are
not allowed to claim the change helped. Add the metric first.

---

## 4. Lever 1 — Stateless replicas behind HAProxy (do this FIRST)

### 4.1 Why it's the biggest lever

Adding a replica adds a nearly-linear amount of request capacity (up to the
shared bottlenecks: Postgres, Redis, PgBouncer). Everything else (caching,
queues) only delays _when_ you need the next replica.

### 4.2 Step-by-step

**Step 1 — build and ship the image** (from CI or locally):

```bash
docker build -t <registry>/ayo-snbt-backend:<tag> .
docker push <registry>/ayo-snbt-backend:<tag>
```

**Step 2 — set the image in the prod compose file:**

```bash
export REGISTRY=<your-registry> TAG=<tag>
```

**Step 3 — scale the API service:**

```bash
docker compose -f compose.prod.yml up -d --scale api=4
```

**Step 4 — tell HAProxy about the new replicas.**

The shipped `docker/haproxy.cfg` has two static backend lines:

```haproxy
backend api
  balance roundrobin
  server api1 api:3000 check inter 5s fall 3 rise 2
  server api2 api:3000 check inter 5s fall 3 rise 2
```

Both lines point at the compose service name `api`; Docker's embedded DNS
round-robins that name across the running replicas, so even without editing
the file all replicas receive traffic. For precise control with many replicas,
generate one line per replica:

```haproxy
server api1 api:3000 check inter 5s fall 3 rise 2
server api2 api:3000 check inter 5s fall 3 rise 2
server api3 api:3000 check inter 5s fall 3 rise 2
server api4 api:3000 check inter 5s fall 3 rise 2
```

then `docker compose -f compose.prod.yml restart haproxy` (or `kill -HUP`
the haproxy PID to reload config without dropping connections).

**Step 5 — verify the replica joined the pool:**

```bash
# 1. HAProxy stats (shows each server's state: UP/DOWN, sessions, errors)
curl http://<vps>:8404/haproxy-stats
# 2. All replicas healthy?
docker compose -f compose.prod.yml ps
# 3. Requests actually flow through the LB (not direct-to-api):
curl -v http://<vps>/api/v1/courses   # note the via: haproxy response or X-Request-Id
# 4. Load test through the LB:
k6 run -e BASE_URL=http://<vps> load/catalog.js
```

**Step 6 — record the new baseline** (same table as §3.3, new replica count).

### 4.3 Replica count formula (worked example)

Per-replica measured targets (typical 2 vCPU / 4 GB):

```
Catalog (cached GET)      ~8,000 req/s
Authenticated GETs        ~5,000 req/s
Health checks             ~10,000 req/s
Leaderboard (cached)      ~6,000 req/s
Streaming redirects       ~2,000 req/s
```

For a **100k req/s mixed workload** (roughly 60% catalog, 30% authed, 10%
other — weighted average ≈ 6,000 req/s per replica):

```
replicas = 100_000 / 6_000 ≈ 17  →  deploy 20 replicas (always round UP and
                                    add a spare; you need headroom for
                                    failover: if one replica dies, the other
                                    19 must absorb 100k → 100k/19 ≈ 5,300
                                    each — still under the 6,000 target ✓)
```

With CDN offloading ~50% of requests (§5) the API only sees:

```
replicas = 50_000 / 6_000 ≈ 9  → 10–12 replicas
```

**Rules of thumb for juniors:**

- Never scale up just because it "feels slow" — look at the metrics first.
- Scale in pairs, verify after each pair, and keep 10–20% headroom.
- `worker` replicas and `api` replicas are DIFFERENT services — scaling
  `api` does NOT give you more grading/transcode capacity (§7).

### 4.4 What can go wrong (and how to spot it)

| Symptom                            | Cause                                        | Fix                                                                   |
| ---------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| New replica shows `DOWN` in stats  | It fails `/health` (or /ready once switched) | `docker compose logs api` — env misconfig? migrations missing?        |
| Load doesn't improve after scaling | Shared bottleneck (PgBouncer pool, Redis)    | Check pools (§6, §8) — this is where you hit the wall next            |
| Connections reset during reload    | HAProxy reload killed sessions               | Use `kill -HUP` for config reloads, not container restart             |
| All traffic hits ONE replica       | Docker DNS not round-robining                | Check `docker compose ps` replica count; use per-replica server lines |

> **Hardening note:** the shipped config health-checks `GET /health` (liveness
> only). For dependency-aware draining (so a replica with a dead Redis/DB is
> pulled out of the pool), switch to `option httpchk GET /ready`. Do this as
> part of the Phase-8 hardening list (§14).

## 5. Lever 2 — CDN offload

### 5.1 What to put on the CDN

| Asset                                           | Cacheable? | TTL suggestion                                   | Notes                                                                                                                 |
| ----------------------------------------------- | ---------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| HLS segments + playlists                        | ✅ public  | 24 h (segments immutable; playlists re-validate) | Biggest win — video is most of your bytes                                                                             |
| Course images / posters                         | ✅ public  | 7–30 d                                           | `S3_BUCKET_IMAGES`                                                                                                    |
| Catalog JSON (`GET /api/v1/courses`)            | ⚠️ short   | 30 s to 5 min                                    | Only if you can tolerate eventual freshness (the app itself caches 30 s — a CDN on top is optional)                   |
| Presigned URLs (upload PUT, private stream GET) | ❌ NEVER   | —                                                | Presigned URLs are short-lived credentials (120 s default). Caching them is a security hole AND breaks (URLs expire). |

### 5.2 Step-by-step

1. Put the CDN (Cloudflare/CloudFront) in front of **media URLs only**:
   `https://cdn.example.com/videos/…`, `https://cdn.example.com/images/…`
   → origin `https://minio.<vps>` (or the S3 bucket's public endpoint).
2. Configure cache rules per path prefix (table above).
3. Keep the API's `307` redirects pointing at **origin** URLs, or point them
   at the CDN domain — either works since the redirect target is fully
   qualified. (Do NOT route the redirect through the API — that defeats the
   zero-copy design.)
4. Verify offload:

```bash
# after a k6 video.js run, compare:
#   bytes served by the API  vs  bytes served by the CDN
# CDN dashboards show cache hit ratio; expect 90%+ on segments.
```

### 5.3 Expected impact

Video/static is typically 50–80% of total request+byte traffic. Offloading it
cuts the API replica count needed for the same user experience (§4.3 math).

---

## 6. Lever 3 — Caching (how it works + how to verify)

### 6.1 The cache layers

```
CDN ──► HAProxy (cacheable, future) ──► API process ──► Redis ──► Postgres
                                      (in-memory LRU,      (cache-aside)
                                       future)
```

The app implements **Redis cache-aside with single-flight** in
`src/shared/cache/cache.ts`:

- **Read path**: handler asks the cache for `key`; on miss it loads from the
  DB and stores it; on hit it returns immediately (no DB query).
- **Single-flight**: concurrent misses for the same key share ONE DB query
  (the rest wait) — this prevents a **cache stampede** (see below).
- **Version tags**: every cache key embeds a version, e.g.
  `courses:list:v<cacheVersion("courses")>:{status}:{cursor}`. Any mutation
  (create/update/delete/publish) bumps the version via the event bus, so all
  cached entries for that entity are invalidated INSTANTLY and atomically —
  no TTL waiting, no manual cache deletes sprinkled through services.
- **Lazy bypass**: when Redis is down (gate degraded), `getCache()` returns a
  bypass that queries the DB directly — reads never fail because of cache.

### 6.2 What is cached today (and its TTL)

| Key pattern                                 | TTL  |
| ------------------------------------------- | ---- |
| `courses:list:v{N}:{status}:{cursor}`       | 30 s |
| `sims:packages:v{N}:{cursor}`               | 30 s |
| `sims:leaderboard:v{N}:{packageId}:{limit}` | 30 s |

**Never cache:** anything user-specific (profile, progress, sessions, orders)
— it would leak data between users. The version-tag design makes it safe to
add cache to any entity: bump the version on mutation and reads are always
eventually fresh.

### 6.3 Cache stampede (why single-flight matters)

Imagine 10 000 students hit the catalog the moment a cache entry expires.
Without single-flight, all 10 000 miss and ALL fire the same DB query at once
— the DB collapses. With single-flight, ONE query runs and the other 9 999
wait for it. Always keep single-flight when adding cache paths.

### 6.4 Step-by-step verification

```bash
# 1. Populate the cache with a couple of catalog requests:
curl -s http://localhost:3000/api/v1/courses > /dev/null
curl -s http://localhost:3000/api/v1/courses > /dev/null

# 2. Inspect Redis:
docker exec ayo-snbt-redis-1 redis-cli --scan --pattern 'courses:list*'

# 3. Cache hit metrics (Prometheus):
sum(rate(ayosnbt_cache_hits_total[5m])) / (sum(rate(ayosnbt_cache_hits_total[5m])) + sum(rate(ayosnbt_cache_misses_total[5m])))

# 4. Prove invalidation works: publish/update a course, then confirm the
#    version key bumped and the old cache entries are gone:
docker exec ayo-snbt-redis-1 redis-cli --scan --pattern 'courses:list*'   # before
curl -X PATCH .../api/v1/courses/<id> -d '{"title":"new"}'
docker exec ayo-snbt-redis-1 redis-cli --scan --pattern 'courses:list*'   # after: different keys
```

Expected: cache hit ratio ≥ 90% on catalog/leaderboard under load; version
keys change on every mutation.

### 6.5 Adding a new cache path (recipe)

1. Wrap the read: `getCache().get(key, loader, ttlMs)`.
2. Build the key with `cacheVersion("entity")`.
3. On mutation: `bumpCacheVersion("entity")` (or emit the domain event —
   `src/shared/events/subscriptions.ts` maps it automatically).
4. NEVER cache user-specific data.
5. Verify with the recipe in §6.4 + a k6 run.

---

## 7. Lever 4 — Async offload (BullMQ workers)

### 7.1 What is queued and why

| Queue       | Work                               | Why async                                               |
| ----------- | ---------------------------------- | ------------------------------------------------------- |
| `email`     | verification/reset/receipt emails  | SMTP is slow; never block a request on it               |
| `transcode` | ffmpeg HLS transcoding             | Minutes of CPU — absolutely must not run in a request   |
| `grading`   | simulation grading + percentile    | Seconds of DB work; the request returns 202 immediately |
| `payment`   | enrollment + receipt after webhook | Webhook must ACK fast; side effects are queued          |

`POST /simulations/sessions/:id/submit` returns **202 Accepted** — the grade
arrives later. `GET /result` returns `NOT_GRADED` until the worker finishes.
This is the pattern: **fast request, heavy work queued.**

### 7.2 Scaling workers step-by-step

```bash
# Scale consumers:
docker compose -f compose.prod.yml up -d --scale worker=2
# Each worker registers 4 consumers (email/transcode/grading/payment) with
# concurrency 5 per queue → 2 workers = up to 10 parallel grading jobs etc.
```

**When to scale workers** (check the gauges):

```
ayosnbt_queue_depth{queue="grading"}      # waiting jobs
ayosnbt_queue_active{queue="grading"}     # in-flight jobs
ayosnbt_queue_delayed{queue="grading"}    # delayed (auto-submit timers)
ayosnbt_queue_failed{queue="grading"}     # failed after 5 retries — ALERT
```

Rule: if `queue_depth` grows faster than `queue_active` drains (depth keeps
climbing), add workers. **Transcode and grading are CPU-heavy** — they benefit
from the ffmpeg worker image and from more workers; email/payment are
I/O-heavy and rarely the bottleneck.

### 7.3 Queue math (sizing example)

Suppose grading takes `t = 500 ms` per job and `r = 2 jobs/s` arrive:

```
needed concurrency = r × t = 2 × 0.5 = 1  →  1 worker is enough
```

For a peak of `r = 20 jobs/s`:

```
needed concurrency = 20 × 0.5 = 10  →  workers = 10 / 5-per-worker = 2 workers
```

### 7.4 Degradation behavior (what happens when Redis is down)

- `enqueue()` catches Redis errors and returns `null`.
- Callers react: simulations refuse to start/submit when grading cannot be
  scheduled (the session would never get graded); payment fulfillment relies
  on webhook replay idempotency.
- `/ready` reports the `queue` gate as `reject` — HAProxy (once switched
  to /ready) would drain replicas rather than serve requests that cannot
  complete their async work.

### 7.5 Inspecting the queues without a UI

```bash
docker exec ayo-snbt-redis-1 redis-cli --scan --pattern 'bull:*:grading:*'
docker exec ayo-snbt-redis-1 redis-cli LLEN bull:grading:wait
# or use the metrics (recommended — they have labels per queue)
```

---

## 8. Lever 5 — PostgreSQL (PgBouncer + read replicas)

### 8.1 PgBouncer transaction pooling (the part juniors must not break)

PgBouncer sits between every API replica and Postgres. It multiplexes many
client connections onto a small pool of real server connections:

```
api1 ─┐
api2 ─┼─► PgBouncer (default_pool_size=40) ──► PostgreSQL
api3 ─┘
```

- **pool_mode = transaction** — a server connection is returned to the pool
  at the end of each transaction. Perfect for Fastify+Drizzle (short
  transactions), terrible for long-held connections.
- **`statement_cache_size = 0`** in `src/shared/db/client.ts` is REQUIRED:
  transaction pooling breaks prepared-statement caching. Never "optimize" it
  back in, or you get random `prepared statement does not exist` errors
  under load.
- `server_reset_query = DISCARD ALL` clears session state between clients.

### 8.2 Sizing PgBouncer (formulas + worked example)

```
max_client_conn  ≥ total app connections = api_replicas × DB_POOL_MAX
                 = 10 × 10 = 100   (current max_client_conn = 1000 — plenty)
default_pool_size ≈ 40 per 10 replicas × 10 connections
                 = 40 × (replicas / 10)
```

For 20 replicas: `default_pool_size ≈ 80`. Watch:
`psql -h localhost -p 6432 -U ayosnbt -d pgbouncer -c "SHOW POOLS;"` →
`cl_active` near `cl_waiting > 0` means clients are queueing → raise the
pool. **`reserve_pool_size`** is the spike buffer.

### 8.3 Read replicas — step-by-step

Reads marked with `getReadDb()` (catalog list, leaderboard) automatically use
`DATABASE_URL_REPLICA` when configured; everything else uses the primary via
PgBouncer.

1. **Create the replica** (on the DB host):

```bash
# Postgres 18 native replication — run on the replica host:
pg_basebackup -h <primary> -D /var/lib/postgresql -U replicator -P -R
# add to postgresql.conf on the primary:
#   wal_level = replica
#   max_wal_senders = 10
# create the replication role:
#   CREATE ROLE replicator LOGIN REPLICATION PASSWORD '...';
```

2. **Point the app at it** — add to `.env.production`:

```bash
DATABASE_URL_REPLICA=postgres://ayosnbt:...@<replica-host>:5432/ayosnbt
```

3. **Deploy** (Jenkins) — replicas get traffic immediately for catalog reads.
4. **Verify** — on the replica: `psql -c "select pg_is_in_recovery();"` → `t`;
   then load-test the catalog and watch primary vs replica CPU.

### 8.4 When NOT to use a replica

- Writes (obviously), and anything that must be immediately consistent
  (your own just-created rows). The code routes reads carefully —
  `getReadDb()` only for catalog/leaderboard. If you add a new read path,
  decide deliberately: replica (eventually consistent) vs primary.

### 8.5 Failover notes

Read replicas are **read-only** today. Promotion (make replica the primary) is
a manual, documented runbook exercise — see Phase 8 hardening (§14). Until
then: if the primary dies, reads still work via the replica; writes 503.

---

## 9. Lever 6 — Zero-copy media

The API never moves video bytes. Uploads go **directly** from the client to S3
via presigned PUT; streaming is a **307 redirect** to a presigned GET
(`src/modules/video/`). API bandwidth for video ≈ 0 — that is what makes
thousands of concurrent viewers cheap.

Verify with `load/video.js`: the API should only serve tiny redirects
(307 + Location header), not byte streams. If you ever see video bytes
flowing through the API process, someone broke zero-copy — fix it.

**Presigned URL lifetime** is `S3_PRESIGN_TTL_SECONDS` (120 s default). The
client must follow the redirect quickly; HLS players do this per segment
(which is why 300 req/s is budgeted for segment redirects per user — §10).

---

## 10. Lever 7 — Rate limiting (edge + per-route)

Two independent layers; both must stay enabled.

### 10.1 HAProxy edge limit (first line of defense)

```haproxy
stick-table type ip size 200k expire 1m store http_req_rate(1m)
http-request deny deny_status 429 if { sc_http_req_rate(0) gt 200 }
```

- Per source IP: > **200 req/s** → 429 at the edge, before a single API
  replica is touched.
- `size 200k` = 200 000 tracked IPs (bump for very large user bases).
- Tune the threshold: legitimate spikes above 200 req/s per IP are rare; if a
  load test comes from ONE machine, it WILL hit this — point tests through
  several workers or raise the limit during testing.

### 10.2 App per-route limits (precision layer)

Redis fixed-window buckets per route (in-memory fallback when Redis is down —
rate limiting is NEVER silently disabled). Defaults:

| Route class            | Limit                               |
| ---------------------- | ----------------------------------- |
| login, forgot-password | 5 / min                             |
| refresh                | 20 / min                            |
| lesson progress        | 60 / min                            |
| video master.m3u8      | 120 / min                           |
| video segments         | 300 / min                           |
| default (no override)  | `RATE_LIMIT_GLOBAL_MAX` (100 / min) |

Exceeded → `429 TOO_MANY_REQUESTS` + `Retry-After` header. **Route
isolation is by design**: a login brute-forcer cannot throttle the catalog.

### 10.3 Verifying rate limiting

```bash
# burst 7 logins in a minute → expect 429 on #6 and #7 with Retry-After:
for i in $(seq 1 7); do curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:3000/api/v1/auth/login -H 'content-type: application/json' -d '{"email":"a@b.c","password":"x"}'; done
```

---

## 11. The traffic-surge runbook (step-by-step)

Follow this when traffic spikes or something is slow. **Do not skip steps.**
Time-box each step; if a step doesn't show improvement in 5 minutes, move on.

```text
□ 1. IS IT REALLY TRAFFIC?
     → Grafana: request rate vs baseline. If rate is normal, the problem is
       a bug, not scale — skip to troubleshooting (§12).

□ 2. CHECK DEGRADATION GATES (always first — free diagnosis)
     → ayosnbt_degradation_gate_mode (or GET /ready).
       If a gate ≠ healthy: Redis is sick. Fix Redis, NOT the app.
       (cache→db, rateLimit→memory, queue→reject, presence→local-only.)

□ 3. API CPU SATURATED? (ayosnbt_http_request_duration_seconds + container CPU)
     YES → scale api replicas:
       docker compose -f compose.prod.yml up -d --scale api=$((CURRENT + 2))
       verify HAProxy stats show new UP servers; re-check latency in 2 min.
     NO → go to step 4.

□ 4. QUEUE BACKLOG? (ayosnbt_queue_depth)
     YES → scale workers:
       docker compose -f compose.prod.yml up -d --scale worker=$((W + 1))
       watch depth drain; check worker CPU (transcode/grading heavy).

□ 5. PGBOUNCER SATURATED? (SHOW POOLS: cl_waiting > 0)
     YES → raise default_pool_size (+reserve_pool_size) in pgbouncer.ini,
       reload pgbouncer; verify Postgres CPU has headroom. If Postgres is
       the wall → optimize queries / add replica (read-heavy) (§8.3).

□ 6. RATE LIMIT DENYING LEGIT TRAFFIC? (429 spike at edge or app)
     Edge → raise the HAProxy stick-table threshold (§10.1) — carefully.
     App → raise RATE_LIMIT_GLOBAL_MAX or the specific route's config.

□ 7. CACHE MISS RATE JUMPED? (ayosnbt_cache_misses_total)
     → version bump storm (deploys, mass updates) or Redis eviction.
       Check maxmemory/evictions: redis-cli INFO stats | grep evicted_keys.
       If evicting: raise maxmemory (512mb in prod compose) or shorten TTLs.

□ 8. RECORD WHAT YOU DID (baseline table + a short note in the incident log).
     Rollback = reverse the last scale command; config changes roll back via
     git. Code hotfixes go through Jenkins — do NOT edit files on the VPS.
```

---

## 12. Latency SLOs (and how to measure each)

| Endpoint class                      | p99 target | Measure with                           |
| ----------------------------------- | ---------- | -------------------------------------- |
| Cached reads (catalog, leaderboard) | < 100 ms   | `load/catalog.js` (threshold built in) |
| Authenticated reads                 | < 200 ms   | `load/authed.js`                       |
| Streaming redirects                 | < 150 ms   | `load/video.js`                        |
| Simulation submit (202 async)       | < 250 ms   | `load/simulation.js`                   |

p99 from k6 (built-in) or Prometheus:

```
histogram_quantile(0.99, sum(rate(ayosnbt_http_request_duration_seconds_bucket[5m])) by (le, route))
```

**Readiness/degradation contract:**

- `/health` — process liveness; never fails on dependency issues.
- `/ready` — dependency readiness + degradation snapshot; HAProxy should
  drain non-200 (currently the shipped config checks /health — see §4.4
  hardening note).

---

## 13. Troubleshooting matrix

| Symptom                                    | Likely cause                                  | Check / fix                                                                                 |
| ------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Random `prepared statement does not exist` | `statement_cache_size` changed                | Restore `statement_cache_size: 0` in `src/shared/db/client.ts`                              |
| 500s only on page 2+ of lists              | unqualified keyset columns with JOINs         | Keyset columns must be fully qualified (`courses.created_at`) — see ADR 0002                |
| 429s everywhere under load                 | edge stick-table too low for test machine     | Raise threshold or spread test load                                                         |
| `TOKEN_REUSE_DETECTED` spike               | stolen refresh tokens being replayed          | Credential-theft wave → force password resets; the family revocation is working as designed |
| Redis evictions grow                       | cache/queue footprint > maxmemory             | `INFO stats` → `evicted_keys`; raise maxmemory or shrink TTLs                               |
| Grading backlog grows                      | workers can't keep up                         | `--scale worker=N` (§7.2)                                                                   |
| WS disconnects at scale                    | HAProxy `timeout tunnel` too low              | It's 1 h in the shipped config; keep it, WS needs long-lived connections                    |
| New replica immediately DOWN               | health check failing                          | `docker compose logs api`; migrations not applied? env wrong?                               |
| `cl_waiting` climbing                      | PgBouncer pool exhausted                      | Raise `default_pool_size` (§8.2)                                                            |
| First request after deploy is slow         | cache cold (version bump on deploy/mutations) | Expected; warm with a smoke request or accept ~30 s of cold misses                          |

---

## 14. Next hardening steps (Phase 8+)

1. **Switch HAProxy health check to `/ready`** for dependency-aware draining
   (§4.4).
2. **Read replica promotion/switchover runbook** (currently manual).
3. **HLS AES-128 encryption** with per-enrollment keys (protect paid video).
4. **DDoS protection at the edge** (Cloudflare in front of HAProxy).
5. **DB partitioning** for question bank + audit logs (they grow unbounded).
6. **HAProxy cache layer** (catalog responses at the LB, `http-response
cache-store`) — offloads Redis and API CPU further.
7. **In-memory LRU** in the API process for the hottest keys (less Redis
   round-trips; invalidate via the same version tags).
8. **Autoscaling** — a cron/agent that watches `ayosnbt_http_requests_total`
   and runs `docker compose up -d --scale api=N` automatically.

## Appendix — metric cheat sheet

```
ayosnbt_http_requests_total{method,status,route}
ayosnbt_http_request_duration_seconds{route}
ayosnbt_cache_hits_total / ayosnbt_cache_misses_total / ayosnbt_cache_singleflight_total
ayosnbt_degradation_gate_mode{gate}          # cache|rateLimit|queue|presence
ayosnbt_redis_breaker_state{breaker}
ayosnbt_queue_depth / _active / _delayed / _failed{queue}
```
