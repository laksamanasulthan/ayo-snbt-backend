# Scaling Ayo-SNBT to 100k req/s

## Architecture levers (in order of impact)

| # | Lever | Impact | Status |
| --- | --- | --- | --- |
| 1 | **Stateless replicas behind HAProxy** | Linear scale-out; the single biggest lever | ✅ built |
| 2 | **CDN offload** (static assets, HLS segments, images) | 60–80% of media/catalog traffic never reaches the API | ✅ presigned URLs; CDN config at deploy |
| 3 | **Layered caching** (CDN → HAProxy cache → in-memory LRU → Redis) | 90%+ read hit rate on catalog/leaderboard | ✅ Redis cache-aside + single-flight |
| 4 | **Async offload via BullMQ** (emails, grading, transcode, fulfillment) | Requests return fast; heavy work queued | ✅ all queues live |
| 5 | **Read replicas + PgBouncer tx-pooling** | Reads never compete with writes | ✅ replica plumbing (DATABASE_URL_REPLICA) |
| 6 | **Zero-copy media** (presigned upload/stream) | API bandwidth ~0 for video | ✅ HLS redirect streaming |
| 7 | **Edge + per-route rate limiting** | Survive traffic spikes/abuse | ✅ HAProxy global + app per-route |

## Capacity math

Per-replica measured targets (typical 2 vCPU / 4 GB):

```
Catalog (cached GET)      ~8,000 req/s
Authenticated GETs        ~5,000 req/s
Health checks             ~10,000 req/s
Leaderboard (cached)      ~6,000 req/s
Streaming redirects       ~2,000 req/s
```

**100k req/s mixed workload** (roughly 60% catalog, 30% authed, 10% other):

```
replicas = 100_000 / 6_000 ≈ 17 → 20 replicas + HAProxy + CDN
```

With CDN offloading all static/HLS/media (~50% of requests), the API needs:

```
replicas = 50_000 / 6_000 ≈ 9 → 10–12 replicas
```

## Operational guidance

- **PgBouncer sizing**: `default_pool_size = 40` per 10 replicas × 10 connections each; bump reserve_pool_size for spikes.
- **Redis**: 256 MB min; watch `ayosnbt_degradation_gate_mode` — gates flip to db/memory/reject automatically.
- **Queues**: watch `ayosnbt_queue_depth`; scale worker replicas (grading/transcode are CPU-heavy).
- **Load tests**: `k6 run load/*.js` before every major release; CI nightly job in Jenkins.
- **Auto-scaling** (VPS): `docker compose up -d --scale api=N` behind HAProxy; health-check drain is automatic.

## Latency SLOs

| Endpoint class | p99 target |
| --- | --- |
| Cached reads (catalog, leaderboard) | < 100 ms |
| Authenticated reads | < 200 ms |
| Streaming redirects | < 150 ms |
| Simulation submit (202 async) | < 250 ms |

## Readiness/degradation contract

- `/health` — process liveness (never fails on dependency issues).
- `/ready` — dependency readiness + degradation snapshot; HAProxy drains non-200.
- Prometheus: `ayosnbt_degradation_gate_mode`, `ayosnbt_queue_*`, `ayosnbt_http_*`.

## Next hardening steps (Phase 8)

- Read replica promotion/switchover runbook
- HLS AES-128 encryption with per-enrollment keys
- DDoS protection at the edge (Cloudflare)
- DB partitioning for question bank + audit logs
