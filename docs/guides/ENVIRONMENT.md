# Environment Variables

All configuration is validated at boot by a zod schema
(`src/config/env.ts`). The app **refuses to start** with invalid config and
refuses to start in `NODE_ENV=production` with any dev default secret
(`assertSecureInProduction`).

Templates: `.env.example` (dev) and `.env.production.example` (prod).

## Reference

| Variable                                                                              | Default                                             | Purpose                                        |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| `NODE_ENV`                                                                            | `development`                                       | `development` / `test` / `production`          |
| `HOST` / `PORT`                                                                       | `0.0.0.0` / `3000`                                  | API bind                                       |
| `TRUST_PROXY`                                                                         | `false`                                             | set `true` behind HAProxy (correct client IPs) |
| `LOG_LEVEL`                                                                           | `info`                                              | pino level                                     |
| `DATABASE_URL`                                                                        | `postgres://ayosnbt:ayosnbt@localhost:6432/ayosnbt` | app pool **via PgBouncer**                     |
| `DIRECT_DATABASE_URL`                                                                 | `postgres://ayosnbt:ayosnbt@localhost:5432/ayosnbt` | migrations/seed (bypass PgBouncer)             |
| `DATABASE_URL_REPLICA`                                                                | —                                                   | read replica for catalog/leaderboard reads     |
| `DB_POOL_MAX`                                                                         | `10`                                                | pg pool size                                   |
| `REDIS_URL`                                                                           | `redis://localhost:6379`                            | cache, rate limit, queues, presence            |
| `REDIS_MAXMEMORY_MB`                                                                  | `256`                                               | health-monitor memory reference                |
| `QUEUE_PREFIX`                                                                        | `ayosnbt`                                           | BullMQ prefix                                  |
| `MONGO_URL`                                                                           | `mongodb://localhost:27017/ayosnbt_chat`            | chat storage                                   |
| `S3_ENDPOINT`                                                                         | `http://localhost:9000`                             | MinIO/S3-compatible                            |
| `S3_REGION`                                                                           | `us-east-1`                                         | S3 region                                      |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY`                                                     | `minioadmin` / `minioadmin`                         | **prod: real credentials**                     |
| `S3_FORCE_PATH_STYLE`                                                                 | `true`                                              | required for MinIO                             |
| `S3_BUCKET_IMAGES` / `S3_BUCKET_VIDEOS`                                               | `ayosnbt-images` / `ayosnbt-videos`                 | buckets                                        |
| `S3_PRESIGN_TTL_SECONDS`                                                              | `120`                                               | presigned URL lifetime                         |
| `JWT_ACCESS_SECRET`                                                                   | dev default (≥32 chars)                             | HS256 signing — **prod: change**               |
| `JWT_ACCESS_TTL`                                                                      | `15m`                                               | access token lifetime                          |
| `REFRESH_TOKEN_TTL_DAYS`                                                              | `30`                                                | refresh token lifetime                         |
| `COOKIE_SECURE`                                                                       | `false`                                             | `true` in prod (Secure flag)                   |
| `COOKIE_DOMAIN`                                                                       | —                                                   | optional cookie domain                         |
| `CSRF_ENABLED`                                                                        | `true`                                              | master switch for CSRF guard                   |
| `SMTP_HOST` / `SMTP_PORT`                                                             | `localhost` / `1025`                                | Mailpit in dev                                 |
| `SMTP_USER` / `SMTP_PASS`                                                             | —                                                   | provider creds (optional)                      |
| `SMTP_FROM`                                                                           | `Ayo-SNBT <no-reply@ayo-snbt.id>`                   | sender                                         |
| `SMTP_SECURE`                                                                         | `false`                                             | TLS for SMTP                                   |
| `OAUTH_ENABLED`                                                                       | `false`                                             | enable Google OAuth2                           |
| `OAUTH_GOOGLE_CLIENT_ID` / `OAUTH_GOOGLE_CLIENT_SECRET` / `OAUTH_GOOGLE_CALLBACK_URL` | —                                                   | Google console creds                           |
| `OAUTH_FRONTEND_REDIRECT_URL`                                                         | `http://localhost:5173`                             | post-login redirect                            |
| `DOCS_ENABLED`                                                                        | `true`                                              | serve Scalar at /docs                          |
| `RATE_LIMIT_GLOBAL_MAX`                                                               | `100`                                               | default per-route limit (per window)           |
| `RATE_LIMIT_GLOBAL_WINDOW_MS`                                                         | `60000`                                             | rate-limit window                              |
| `PAYMENT_PROVIDER`                                                                    | `mock`                                              | `mock` / `midtrans` / `xendit`                 |
| `MIDTRANS_SERVER_KEY` / `MIDTRANS_CLIENT_KEY` / `MIDTRANS_BASE_URL`                   | — / — / sandbox URL                                 | Midtrans                                       |
| `XENDIT_SECRET_KEY` / `XENDIT_CALLBACK_TOKEN` / `XENDIT_BASE_URL`                     | —                                                   | Xendit                                         |
| `PAYMENT_BASE_URL`                                                                    | `http://localhost:3000`                             | base for mock payment URL                      |
| `CORS_ORIGIN`                                                                         | `http://localhost:5173`                             | allowed origin                                 |

## Boolean parsing gotcha

`z.coerce.boolean()` would turn the string `"false"` into `true` — all
boolean vars use the `boolFromEnv` preprocessor. If you add a boolean env
var, use `boolFromEnv` (see `src/config/env.ts`).

## Production checklist

1. `NODE_ENV=production`
2. `JWT_ACCESS_SECRET` — fresh random ≥ 32 chars
3. `COOKIE_SECURE=true`, `TRUST_PROXY=true`, real `CORS_ORIGIN`
4. Real `S3_ACCESS_KEY`/`S3_SECRET_KEY` + bucket names
5. `SMTP_*` pointing at a real provider
6. `PAYMENT_PROVIDER` + provider keys + `PAYMENT_BASE_URL`
7. `DATABASE_URL` / `DIRECT_DATABASE_URL` / optional replica
8. `OAUTH_*` when enabling social login
