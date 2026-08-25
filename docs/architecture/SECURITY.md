# Security Model

Authentication, authorization, and the abuse-resistance layers. See also
[API-CONVENTIONS.md](./API-CONVENTIONS.md) for the wire contract.

## Authentication flows

### Register → verify → login

```
POST /auth/register            → creates user (status pending) + verification
                                 token (24 h) + verify-email mail (queued)
GET  /auth/verify-email?token  → marks email verified, status active
POST /auth/login               → checks lockout → verifies argon2 hash →
                                 sets access_token + refresh_token + csrf_token
                                 cookies (httpOnly, SameSite=Lax)
```

- Registration validates `format: email` and password `minLength: 8`;
  duplicates → `409 EMAIL_TAKEN`.
- Unknown email + wrong password return the SAME error
  (`AUTH_INVALID_CREDENTIALS`) — no enumeration. A dummy argon2 hash is
  verified so timing is constant-ish.
- Unverified login → `403 EMAIL_NOT_VERIFIED`.

### Refresh rotation (session security)

1. `POST /auth/refresh` with the refresh cookie rotates the token: the old
   row is revoked and a new one issued in the SAME family.
2. Rotation is atomic (`WHERE revoked_at IS NULL`): two concurrent refreshes
   with the same token → exactly one succeeds, the other gets
   `TOKEN_REUSE_DETECTED` and the whole family is revoked (theft response).
3. Presenting ANY revoked token → `TOKEN_REUSE_DETECTED` + family revocation.
4. Expired refresh tokens → `TOKEN_EXPIRED`; garbage → `UNAUTHORIZED`.
5. Logout revokes the presented token; double logout is a no-op.
6. Password reset revokes ALL sessions for the account.

### Password reset

`POST /auth/forgot-password` always returns 200 (no enumeration); when the
email exists, a one-time token (15 min) is emailed. `POST /auth/reset-password`
accepts `{ token, password }`; the token is single-use and expiry-checked.

### OAuth2 (Google)

- `OAUTH_ENABLED` gates the Google flow; callback exchanges the code, fetches
  the profile, and links by `provider_user_id` or by matching email.
- New users are created verified with the student role.

## Cookie & token properties

| Cookie          | Contents                                                                     | Flags                                                    |
| --------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `access_token`  | JWT HS256, 15 min (`JWT_ACCESS_TTL`), claims: sub, email, roles, permissions | httpOnly, SameSite=Lax, secure in prod (`COOKIE_SECURE`) |
| `refresh_token` | opaque random, stored hashed (sha256) in `refresh_tokens`                    | httpOnly, SameSite=Lax, secure in prod                   |
| `csrf_token`    | random value                                                                 | SameSite=Lax (double-submit pattern)                     |

Access-token claims include roles + permissions so authorization costs ZERO
DB hits. Refresh tokens are stored hashed — a DB leak does not expose usable
tokens.

## CSRF

Mutating methods require `x-csrf-token` == `csrf_token` cookie
(double-submit). GET/HEAD/OPTIONS are exempt; payment webhooks opt out
(`config: { csrf: false }`) because they authenticate by signature.

## Login lockout (abuse resistance)

Exponential windows per `email + ip` (Redis, 1 h sliding window):

| Failures | Window |
| -------- | ------ |
| ≥ 5      | 5 min  |
| ≥ 10     | 15 min |
| ≥ 15     | 60 min |

Locked → `401 ACCOUNT_LOCKED` even with the correct password. Successful
login clears the counter. Redis down → lockout is best-effort (no-op), but
the route rate limit (5/min) still applies.

## Authorization (RBAC)

- Roles: `student`, `mentor`, `admin`; permissions seeded in Postgres
  (16). Role→permission matrix in `src/shared/rbac/permissions.ts`
  (`ROLE_SEED`).
- `requirePermission(perm)` preHandler checks the JWT claims — no DB hit.
- Route gate is the FIRST layer; services ALSO enforce ownership
  (creator/owner or admin) for cross-tenant safety:
  - courses/lessons: owner or admin (publish/update/addLesson/delete)
  - questions: creator or admin (update/delete/restore)
  - simulation packages: mentor/admin manage; sessions are user-scoped
    (404 for other users)
  - orders: user-scoped reads; refund requires `payment:refund` (admin)
  - IAM: `iam:manage` (admin) — role assignment validates user AND role
    exist (404, never FK 500)
- Students CAN upload videos (`video:upload` in the student seed) but
  cannot transcode.

## Video streaming gates

`assertCanStream` before any 307 redirect: video must be `ready`; then
free lessons stream for everyone, paid lessons require enrollment (or
course owner/admin), and videos attached to no lesson are mentor/admin-only.
Deleted videos → 404. Segment paths must match
`^[a-zA-Z0-9_/-]+\.(ts|m3u8|m4s|mp4)$` (traversal protection).

## Payments security

- Providers: mock (dev), Midtrans (SHA512 signature),
  Xendit (`x-callback-token` header).
- Webhooks: signature verified FIRST (`400 WEBHOOK_SIGNATURE_INVALID` on
  failure); events deduped by `event_id` (idempotent even under replay).
- See [PAYMENTS.md](../services/PAYMENTS.md).

## Environment & production guardrails

- `assertSecureInProduction` refuses to boot with any dev default secret
  (JWT secret, minioadmin, dev DB URLs) when `NODE_ENV=production`.
- `COOKIE_SECURE=true` + `TRUST_PROXY=true` behind HAProxy.
- Rate limiting is never disabled: Redis-down switches to in-memory buckets.
- Never commit `.env` / `.env.production` (gitignored); docs use
  placeholders only.
