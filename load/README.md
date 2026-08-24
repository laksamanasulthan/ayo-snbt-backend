# k6 Load Tests

## Prerequisites
- [k6](https://k6.io) binary installed
- Ayo-SNBT backend running on `BASE_URL` (default http://localhost:3000)
- For authenticated scenarios: `ACCESS_TOKEN` env with a valid JWT
- For video: `VIDEO_ID` env pointing to a ready video
- For simulation: `SIM_PACKAGE_ID` env

## Run

```bash
# Public catalog (cached, 100 req/s target)
k6 run load/catalog.js

# Authenticated endpoints (50 req/s, needs token)
ACCESS_TOKEN=eyJ... k6 run load/authed.js

# Video streaming profile (20 req/s, needs token + video)
ACCESS_TOKEN=eyJ... VIDEO_ID=abc-123 k6 run load/video.js

# Simulation packages (30 req/s, needs token)
ACCESS_TOKEN=eyJ... SIM_PACKAGE_ID=abc-123 k6 run load/simulation.js
```

## Scale-out formula

| Metric | Measured target | Notes |
|---|---|---|
| Catalog (GET /courses) | 8k req/s per replica | Fully cached in Redis; CDN offload recommended |
| Authenticated (/users/me) | 5k req/s per replica | JWT stateless, no DB hit |
| /health + /ready | 10k req/s per replica | Lightweight, no DB |
| Leaderboard | 6k req/s per replica | Cached 30s, read-replica capable |
| Video streaming | 2k req/s per replica | 307 redirects (zero proxy bandwidth) |

**Scale to 100k req/s:** 12–15 stateless API replicas behind HAProxy + CDN for static/HLS + read replicas for catalog/leaderboard.

```
Total replicas = ceil(target_rps / per_instance_rps) + CDN_offload
```